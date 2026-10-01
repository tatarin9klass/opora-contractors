-- ============================================================================
-- Звонки: честное определение разговора.
--
-- ПОЧЕМУ ПЕРВОЕ ОПРЕДЕЛЕНИЕ БЫЛО НЕВЕРНЫМ. Считать дозвоном наличие записи
-- разговора оказалось нельзя, и распределение по длительности показывает
-- почему:
--     0 сек        86 926 звонков, записей 2      — гудки, тут правило работает
--     1-5 сек      59 813 звонков, записей 54 061 — автоответ оператора связи
--     6-10 сек     47 088 звонков, записей 45 151 — то же самое
--     больше 3 мин 34 858 звонков, записей  7 927 — а тут ломается длительность
--
-- То есть запись пишется и когда отвечает не человек, а автоинформатор
-- («аппарат абонента выключен»). Сто тысяч таких звонков и давали
-- неправдоподобные 74% связи с первой попытки.
--
-- А на длинных звонках ломается уже длительность: END_TIME в Битриксе — это
-- когда ЗАКРЫЛИ карточку активности, а не когда положили трубку. Отсюда
-- средняя «длительность разговора» в 72 минуты у одного из менеджеров.
--
-- РАБОЧЕЕ ОПРЕДЕЛЕНИЕ — два уровня, по оценке руководителя направления:
--   дозвон  = трубку взяли, от 35 секунд
--   диалог  = реально поговорили, от минуты
-- Оценка приблизительная, поэтому ниже есть витрина чувствительности: видно,
-- насколько выводы зависят от выбранного порога. Верхняя граница в час
-- отсекает зависшие карточки активностей.
--
-- Порог намеренно вынесен в функцию: он спорный, и менять его придётся в
-- одном месте, а не в шести витринах. Когда вебхуку выдадут право
-- «Телефония», эвристика заменится точным кодом завершения вызова из
-- voximplant.statistic.get — правкой одной функции.
--
-- ВТОРАЯ ПРАВКА: в попытки дозвона больше не идут входящие звонки (их 16 996)
-- и незавершённые активности — запланированные «перезвонить в четверг».
-- Входящий звонок это не попытка, а её результат.
-- ============================================================================

-- Дозвон: трубку взяли.
create or replace function bfl_call_answered(has_rec boolean, dur integer)
returns boolean language sql immutable as $$
  select coalesce(has_rec, false) and dur is not null and dur >= 35 and dur <= 3600;
$$;

-- Диалог: не просто взяли трубку, а поговорили.
create or replace function bfl_call_dialogue(has_rec boolean, dur integer)
returns boolean language sql immutable as $$
  select coalesce(has_rec, false) and dur is not null and dur >= 60 and dur <= 3600;
$$;

-- Исходящая завершённая активность = одна попытка дозвона.
create or replace function bfl_call_is_attempt(dir smallint, done boolean)
returns boolean language sql immutable as $$
  select coalesce(done, false) and coalesce(dir, 2) = 2;
$$;

-- ============================================================================
-- Насколько выводы зависят от выбранного порога
-- ============================================================================
drop view if exists bfl_calls_threshold_sensitivity;
create view bfl_calls_threshold_sensitivity with (security_invoker = true) as
select
  t.sec::integer as порог_секунд,
  count(*) filter (
    where c.has_recording and c.duration_sec >= t.sec and c.duration_sec <= 3600
  )::integer as разговоров,
  round(100.0 * count(*) filter (
    where c.has_recording and c.duration_sec >= t.sec and c.duration_sec <= 3600
  ) / nullif(count(*), 0), 1) as доля_связи
from bfl_lead_calls c
cross join (values (5), (10), (20), (30), (35), (45), (60), (90), (120)) as t(sec)
where bfl_call_is_attempt(c.direction, c.completed)
group by t.sec;

-- ============================================================================
-- По лидам
-- ============================================================================
drop view if exists bfl_calls_by_lead cascade;
create view bfl_calls_by_lead with (security_invoker = true) as
select
  l.lead_id,
  l.source_marker,
  l.status_name as стадия_лида,
  count(c.id) filter (where bfl_call_is_attempt(c.direction, c.completed))::integer as попыток,
  count(c.id) filter (
    where bfl_call_is_attempt(c.direction, c.completed)
      and bfl_call_answered(c.has_recording, c.duration_sec)
  )::integer as дозвонов,
  count(c.id) filter (
    where bfl_call_is_attempt(c.direction, c.completed)
      and bfl_call_dialogue(c.has_recording, c.duration_sec)
  )::integer as диалогов,
  -- Входящие держим отдельно: человек перезвонил сам, это ценный сигнал.
  count(c.id) filter (where c.direction = 1 and c.completed)::integer as входящих,
  min(c.started_at) filter (where bfl_call_is_attempt(c.direction, c.completed)) as первая_попытка,
  max(c.started_at) filter (where bfl_call_is_attempt(c.direction, c.completed)) as последняя_попытка,
  (l.qualified_at is not null) as стал_квалом
from bfl_lead_timings l
left join bfl_lead_calls c on c.lead_id = l.lead_id
where l.source_marker is null
   or l.source_marker not in (select source_marker from bfl_excluded_sources)
group by l.lead_id, l.source_marker, l.status_name, l.qualified_at;

-- ============================================================================
-- По источникам
-- ============================================================================
drop view if exists bfl_calls_by_source;
create view bfl_calls_by_source with (security_invoker = true) as
select
  source_marker as источник,
  count(*)::integer as лидов,
  round(avg(попыток)::numeric, 1) as среднее_попыток,
  round((percentile_cont(0.5) within group (order by попыток))::numeric, 1) as медиана_попыток,
  count(*) filter (where попыток = 0)::integer as без_единой_попытки,
  count(*) filter (where дозвонов > 0)::integer as дозвонились,
  round(100.0 * count(*) filter (where дозвонов > 0) / nullif(count(*), 0), 1) as доля_дозвона,
  count(*) filter (where диалогов > 0)::integer as поговорили,
  round(100.0 * count(*) filter (where диалогов > 0) / nullif(count(*), 0), 1) as доля_диалогов,
  count(*) filter (where входящих > 0)::integer as перезвонили_сами,
  count(*) filter (where стал_квалом)::integer as квалов,
  round(100.0 * count(*) filter (where стал_квалом) / nullif(count(*), 0), 1) as конверсия_в_квал
from bfl_calls_by_lead
where source_marker is not null
group by 1;

-- ============================================================================
-- По менеджерам
--
-- Средняя длительность убрана намеренно: END_TIME это время закрытия карточки,
-- а не конца разговора, и цифра получалась бессмысленной (72 минуты «на звонок»).
-- Вернём, когда будет точная длительность из телефонии.
-- ============================================================================
drop view if exists bfl_calls_by_manager;
create view bfl_calls_by_manager with (security_invoker = true) as
select
  coalesce(c.responsible_name, '— не загружен —') as менеджер,
  count(*)::integer as попыток,
  count(*) filter (where bfl_call_answered(c.has_recording, c.duration_sec))::integer as дозвонов,
  round(100.0 * count(*) filter (where bfl_call_answered(c.has_recording, c.duration_sec))
        / nullif(count(*), 0), 1) as доля_дозвона,
  count(*) filter (where bfl_call_dialogue(c.has_recording, c.duration_sec))::integer as диалогов,
  round(100.0 * count(*) filter (where bfl_call_dialogue(c.has_recording, c.duration_sec))
        / nullif(count(*), 0), 1) as доля_диалогов,
  count(distinct c.lead_id)::integer as лидов,
  round(count(*)::numeric / nullif(count(distinct c.lead_id), 0), 1) as попыток_на_лид
from bfl_lead_calls c
join bfl_lead_timings l on l.lead_id = c.lead_id
where bfl_call_is_attempt(c.direction, c.completed)
  and (l.source_marker is null
       or l.source_marker not in (select source_marker from bfl_excluded_sources))
group by 1;

-- ============================================================================
-- По часам (новосибирское время — в нём живут и те, кто звонит, и те, кому звонят)
-- ============================================================================
drop view if exists bfl_calls_by_hour;
create view bfl_calls_by_hour with (security_invoker = true) as
select
  extract(hour from (c.started_at at time zone 'Asia/Novosibirsk'))::integer as час,
  count(*)::integer as попыток,
  count(*) filter (where bfl_call_answered(c.has_recording, c.duration_sec))::integer as дозвонов,
  round(100.0 * count(*) filter (where bfl_call_answered(c.has_recording, c.duration_sec))
        / nullif(count(*), 0), 1) as доля_дозвона,
  count(*) filter (where bfl_call_dialogue(c.has_recording, c.duration_sec))::integer as диалогов
from bfl_lead_calls c
join bfl_lead_timings l on l.lead_id = c.lead_id
where bfl_call_is_attempt(c.direction, c.completed)
  and c.started_at is not null
  and (l.source_marker is null
       or l.source_marker not in (select source_marker from bfl_excluded_sources))
group by 1;

-- ============================================================================
-- Профиль попыток: на какой по счёту перестают звонить и когда перестаёт
-- получаться
-- ============================================================================
drop view if exists bfl_calls_attempt_profile;
create view bfl_calls_attempt_profile with (security_invoker = true) as
with numbered as (
  select
    c.has_recording,
    c.duration_sec,
    row_number() over (partition by c.lead_id order by c.started_at) as номер_попытки
  from bfl_lead_calls c
  join bfl_lead_timings l on l.lead_id = c.lead_id
  where bfl_call_is_attempt(c.direction, c.completed)
    and c.started_at is not null
    and (l.source_marker is null
         or l.source_marker not in (select source_marker from bfl_excluded_sources))
)
select
  номер_попытки::integer,
  count(*)::integer as сделано_звонков,
  count(*) filter (where bfl_call_answered(has_recording, duration_sec))::integer as дозвонов,
  round(100.0 * count(*) filter (where bfl_call_answered(has_recording, duration_sec))
        / nullif(count(*), 0), 1) as доля_дозвона,
  count(*) filter (where bfl_call_dialogue(has_recording, duration_sec))::integer as диалогов,
  round(100.0 * count(*) filter (where bfl_call_dialogue(has_recording, duration_sec))
        / nullif(count(*), 0), 1) as доля_диалогов
from numbered
where номер_попытки <= 20
group by 1;

-- ============================================================================
-- Ещё один источник в исключения: сайт тоже ловил спам-атаку.
--
-- Из-за неё цифры по нему не читаются: 389 лидов из 1207 не получили ни
-- одного звонка, и выглядело это как упущение отдела, хотя на деле часть
-- заявок была автоматическим мусором, который правильно не обзванивали.
-- Отличить одно от другого внутри источника нечем, поэтому берём его целиком
-- вне статистики, как и КО1.
-- ============================================================================
insert into bfl_excluded_sources (source_marker, reason) values (
  'ofbfl-Сайт ОПОРА (заявка)',
  'Спам-атака на форму сайта в периоде. Часть заявок — автоматический мусор, ' ||
  'отделить его внутри источника нечем. Искажает долю необзвоненных лидов и ' ||
  'конверсию в квал.'
) on conflict (source_marker) do nothing;
