-- ============================================================================
-- Менеджер целиком: разговор → квал → встреча → явка.
--
-- ЗАЧЕМ ЭТО ПОНАДОБИЛОСЬ. Появились две таблицы по менеджерам, и возник
-- соблазн их сложить: доля дозвона из звонков и доходимость встреч. Проверка
-- показала, что складывать нечего — корреляция Спирмена между долей диалогов
-- и доходимостью равна −0,12, то есть связи нет:
--
--     Островская   диалоги 2,7% (12-е место)   доходимость 58,2% (1-е)
--     Кузина       диалоги 5,5% (1-е место)    доходимость 39,9% (7-е из 9)
--
-- Это не шум, а содержательный факт: дозвониться и довести до явки — разные
-- навыки. Общий «рейтинг эффективности» из них собирать нельзя, он усреднит
-- и спрячет обе проблемы.
--
-- Зато между этими двумя метриками есть ровно одно непосчитанное звено:
-- ИЗ ТЕХ, С КЕМ ПОГОВОРИЛИ, СКОЛЬКО ОТКВАЛИЛИ. Доходимость меряет то, что
-- после квала, диалоги — то, что до. Конверсия разговора в квал — то, что
-- между. Её и считаем здесь.
--
-- ДВЕ МЕТОДИЧЕСКИЕ ПОПРАВКИ, без которых цифры врут.
--
-- 1. Доля дозвона на ПОПЫТКУ непригодна для оценки человека. При 15-22
--    попытках на лида метрика становится обратной: кто упорнее добивает
--    мёртвые номера, у того процент хуже.
--        Шелест     22,4 попытки на лид → 2,9% дозвона
--        Кашина     12,4 попытки на лид → 8,8% дозвона
--    Поэтому ниже всё считается на ЛИДОВ: с каким числом людей менеджер
--    действительно поговорил хотя бы раз.
--
-- 2. Абсолютный уровень дозвона недостоверен. Витрина чувствительности
--    показала плавное падение без полки (5 с → 44,6%, 35 с → 6,8%,
--    60 с → 3,8%), то есть естественной границы «взяли трубку» в данных нет.
--    Ранжирование менеджеров при смене порога почти не меняется, поэтому
--    пользуемся сравнениями, а абсолютные проценты не выносим наружу, пока
--    вебхуку не выдадут право «Телефония».
-- ============================================================================

-- ============================================================================
-- Кому приписывается лид
--
-- Лида набирают несколько человек, и приписать квал всем — значит посчитать
-- его несколько раз. Правило: лид приписывается тому, кто ПОСЛЕДНИМ
-- поговорил с ним до момента квала (а если квала нет — последнему, кто
-- поговорил вообще). Логика простая: именно этот разговор либо дал квал,
-- либо не дал.
--
-- Правило симметричное — и для успеха, и для неудачи берётся последний
-- разговор, так что перекоса в чью-то пользу оно не создаёт.
-- ============================================================================
drop view if exists bfl_lead_dialogue_owner cascade;
create view bfl_lead_dialogue_owner with (security_invoker = true) as
with qual as (
  -- История стадий точнее, но покрывает не всех: для остальных берём дату
  -- квалификации из самого лида.
  select
    l.lead_id,
    l.source_marker,
    coalesce(q.qual_at, l.qualified_at) as qual_at
  from bfl_lead_timings l
  left join bfl_lead_qual_moment q on q.lead_id = l.lead_id
  where l.source_marker is null
     or l.source_marker not in (select source_marker from bfl_excluded_sources)
),
dialogues as (
  select
    c.lead_id,
    c.responsible_name,
    c.started_at,
    row_number() over (
      partition by c.lead_id
      order by c.started_at desc
    ) as rn
  from bfl_lead_calls c
  join qual k on k.lead_id = c.lead_id
  where bfl_call_is_attempt(c.direction, c.completed)
    and bfl_call_dialogue(c.has_recording, c.duration_sec)
    and c.started_at is not null
    -- разговоры ПОСЛЕ квала к получению квала отношения не имеют
    and (k.qual_at is null or c.started_at < k.qual_at)
)
select
  k.lead_id,
  k.source_marker,
  d.responsible_name as поговорил_последним,
  d.started_at as последний_диалог,
  (k.qual_at is not null) as стал_квалом
from qual k
join dialogues d on d.lead_id = k.lead_id and d.rn = 1;

-- ============================================================================
-- Главная витрина: конверсия разговора в квал по менеджерам
--
-- Знаменатель — лиды, с которыми менеджер поговорил. Числитель — сколько из
-- них стали квалом. Это уже не про телефонию и не про качество номеров:
-- трубку взяли, разговор состоялся, дальше дело в разговоре.
-- ============================================================================
drop view if exists bfl_manager_dialogue_conversion;
create view bfl_manager_dialogue_conversion with (security_invoker = true) as
select
  coalesce(поговорил_последним, '— не загружен —') as менеджер,
  count(*)::integer as поговорил_с_лидами,
  count(*) filter (where стал_квалом)::integer as из_них_квалов,
  round(100.0 * count(*) filter (where стал_квалом) / nullif(count(*), 0), 1)
    as конверсия_диалога_в_квал,
  min(последний_диалог)::date as первый_разговор,
  max(последний_диалог)::date as последний_разговор
from bfl_lead_dialogue_owner
group by 1;

-- ============================================================================
-- Охват на уровне лидов: с каким числом людей менеджер вообще поговорил
--
-- Замена доли дозвона на попытку. Здесь знаменатель — лиды, которым он
-- звонил, а не звонки, поэтому упорный перезвон метрику больше не портит.
-- ============================================================================
drop view if exists bfl_manager_lead_coverage;
create view bfl_manager_lead_coverage with (security_invoker = true) as
with per_pair as (
  select
    c.responsible_name,
    c.lead_id,
    count(*) filter (where bfl_call_is_attempt(c.direction, c.completed))::integer as попыток,
    count(*) filter (
      where bfl_call_is_attempt(c.direction, c.completed)
        and bfl_call_answered(c.has_recording, c.duration_sec)
    )::integer as дозвонов,
    count(*) filter (
      where bfl_call_is_attempt(c.direction, c.completed)
        and bfl_call_dialogue(c.has_recording, c.duration_sec)
    )::integer as диалогов
  from bfl_lead_calls c
  join bfl_lead_timings l on l.lead_id = c.lead_id
  where l.source_marker is null
     or l.source_marker not in (select source_marker from bfl_excluded_sources)
  group by 1, 2
)
select
  coalesce(responsible_name, '— не загружен —') as менеджер,
  count(*) filter (where попыток > 0)::integer as набирал_лидов,
  sum(попыток)::integer as всего_попыток,
  round(sum(попыток)::numeric / nullif(count(*) filter (where попыток > 0), 0), 1)
    as попыток_на_лид,
  count(*) filter (where дозвонов > 0)::integer as дозвонился_до_лидов,
  round(100.0 * count(*) filter (where дозвонов > 0)
        / nullif(count(*) filter (where попыток > 0), 0), 1) as доля_лидов_с_дозвоном,
  count(*) filter (where диалогов > 0)::integer as поговорил_с_лидами,
  round(100.0 * count(*) filter (where диалогов > 0)
        / nullif(count(*) filter (where попыток > 0), 0), 1) as доля_лидов_с_диалогом,
  -- Сколько попыток уходит на один состоявшийся разговор. Самая честная
  -- мера усилия: не зависит ни от размера базы, ни от упорства.
  round(sum(попыток)::numeric / nullif(sum(диалогов), 0), 1) as попыток_на_диалог
from per_pair
group by 1;

-- ============================================================================
-- Весь путь менеджера в одной строке
--
-- Три блока рядом: обзвон (сколько людей достал), разговор (сколько из них
-- отквалил), встреча (сколько назначил и сколько дошло). Нужна именно
-- рядоположенность, а не сводный балл: из таблицы должно быть видно, что
-- человек силён на одном участке и слаб на другом — в этом вся ценность.
--
-- Соединение по ФИО. В звонках ответственный приходит из user.get как
-- «Фамилия Имя», во встречах «кто назначил» — в том же виде, поэтому имена
-- совпадают. Если у кого-то в портале поменяют написание, строка просто
-- разъедется на две — это видно глазом и лечится правкой в Битриксе.
-- ============================================================================
drop view if exists bfl_manager_full_funnel;
create view bfl_manager_full_funnel with (security_invoker = true) as
with meetings as (
  select
    coalesce(scheduled_by_name, '— не указан —') as менеджер,
    count(*)::integer as назначено,
    count(*) filter (where stage_id = 'DT1044_64:SUCCESS')::integer as состоялось,
    round(
      100.0 * count(*) filter (where stage_id = 'DT1044_64:SUCCESS')
      / nullif(count(*) filter (where stage_id in ('DT1044_64:SUCCESS', 'DT1044_64:FAIL')), 0)
    , 1) as доходимость
  from bfl_meeting_timings
  where source_marker is not null
    and bfl_meeting_moment(scheduled_at, held_at) is not null
  group by 1
)
select
  coalesce(cov.менеджер, conv.менеджер, m.менеджер) as менеджер,
  cov.набирал_лидов,
  cov.попыток_на_лид,
  cov.попыток_на_диалог,
  cov.доля_лидов_с_диалогом,
  conv.поговорил_с_лидами,
  conv.из_них_квалов,
  conv.конверсия_диалога_в_квал,
  m.назначено,
  m.состоялось,
  m.доходимость
from bfl_manager_lead_coverage cov
full join bfl_manager_dialogue_conversion conv on conv.менеджер = cov.менеджер
full join meetings m on m.менеджер = coalesce(cov.менеджер, conv.менеджер);

-- ============================================================================
-- Та же конверсия разговора в квал, но по источникам
--
-- Нужна как контроль к таблице по менеджерам: если у менеджера низкая
-- конверсия разговора, надо знать, не достаются ли ему разговоры по заведомо
-- слабым источникам. При равном распределении лидов (а оно равное и
-- контролируется) различия остаются за человеком.
-- ============================================================================
drop view if exists bfl_dialogue_conversion_by_source;
create view bfl_dialogue_conversion_by_source with (security_invoker = true) as
select
  source_marker as источник,
  count(*)::integer as поговорили_с_лидами,
  count(*) filter (where стал_квалом)::integer as из_них_квалов,
  round(100.0 * count(*) filter (where стал_квалом) / nullif(count(*), 0), 1)
    as конверсия_диалога_в_квал
from bfl_lead_dialogue_owner
where source_marker is not null
group by 1;

-- ============================================================================
-- Где теряется квал: стадия × был ли разговор
--
-- Это ответ на главный вопрос ветки — сколько квала выходит из недозвона,
-- Дозвонились и Скорозвона и что с этим делать. Разрез по тому, был ли
-- разговор после входа в стадию, разделяет две совершенно разные потери:
--
--   не поговорили → проблема в номерах и обзвоне;
--   поговорили, но квала нет → проблема в разговоре.
--
-- Лечатся они противоположными способами, и без этого разреза их не
-- различить.
-- ============================================================================
drop view if exists bfl_stage_dialogue_split;
create view bfl_stage_dialogue_split with (security_invoker = true) as
with entered as (
  select
    h.lead_id,
    h.status_id,
    h.status_name,
    min(h.entered_at) as first_in
  from bfl_lead_stage_history h
  join bfl_lead_timings l on l.lead_id = h.lead_id
  where h.status_id in ('11', '23', 'UC_GKWGR0')
    and (l.source_marker is null
         or l.source_marker not in (select source_marker from bfl_excluded_sources))
  group by h.lead_id, h.status_id, h.status_name
),
with_calls as (
  select
    e.status_id,
    e.status_name,
    e.lead_id,
    (q.qual_at is not null and q.qual_at > e.first_in) as reached_qual,
    count(c.id) filter (
      where bfl_call_is_attempt(c.direction, c.completed)
        and c.started_at >= e.first_in
    )::integer as попыток_после_входа,
    count(c.id) filter (
      where bfl_call_is_attempt(c.direction, c.completed)
        and bfl_call_dialogue(c.has_recording, c.duration_sec)
        and c.started_at >= e.first_in
    )::integer as диалогов_после_входа
  from entered e
  left join bfl_lead_qual_moment q on q.lead_id = e.lead_id
  left join bfl_lead_calls c on c.lead_id = e.lead_id
  group by e.status_id, e.status_name, e.lead_id, q.qual_at, e.first_in
)
select
  status_name as стадия,
  case
    when попыток_после_входа = 0 then '1. ни одной попытки'
    when диалогов_после_входа = 0 then '2. звонили, не поговорили'
    else '3. поговорили'
  end as что_было,
  count(*)::integer as лидов,
  count(*) filter (where reached_qual)::integer as дошли_до_квала,
  round(100.0 * count(*) filter (where reached_qual) / nullif(count(*), 0), 1)
    as конверсия_в_квал,
  round(avg(попыток_после_входа)::numeric, 1) as среднее_попыток
from with_calls
group by 1, 2;
