-- ============================================================================
-- Лиды, которым не сделали ни одного исходящего звонка.
--
-- ОТКУДА ЦИФРА. Разрез скорости первого звонка по окнам прихода дал колонку
-- «не позвонили»: 1089 утренних, 1061 дневных, 839 вечерних, 558 ночных —
-- ИТОГО 3547, то есть 22,1% всей базы.
--
-- И распределены они ровно: 23% утренних, 21% дневных, 23% вечерних, 22%
-- ночных. Значит это не вопрос графика работы и не следствие вечернего
-- провала — это систематическая утечка, одинаковая в любое время суток.
-- Искать её надо в другом разрезе.
--
-- ЧТО УЖЕ ИЗВЕСТНО. Два источника не обзваниваются вовсе: «Электронная почта»
-- (75 лидов, ноль попыток) и «другое (см. комментарий)» (394 лида,
-- 0,3 попытки на лида). Это вместе около 470 из 3547. Остальные три тысячи
-- где-то ещё.
--
-- ЧЕГО ОЖИДАТЬ. Версии, которые разрез должен развести:
--   дубли            — лид заведён дважды, звонят по одному из них;
--   входящие         — человек позвонил сам, исходящий не нужен (источники с
--                      пометкой (ЗВ) так и работают: у 2ГИС 194 квала при 123
--                      разговорах);
--   мгновенный брак  — лид закрыли по стадии, не набирая: другой регион,
--                      ошибочная заявка;
--   настоящая потеря — лид лежит на рабочей стадии, и его просто не взяли.
-- Лечится только последнее, и важно не выдать за него первые три.
--
-- Конверсия в квал у необзвоненных 2,7-10,2% против 30-35% у тех, кого
-- набрали в течение часа. Если хотя бы треть этих трёх тысяч окажется
-- настоящей потерей, это крупнее вечерней смены.
-- ============================================================================

drop view if exists bfl_uncalled_leads cascade;
create view bfl_uncalled_leads with (security_invoker = true) as
select
  l.lead_id,
  l.source_marker,
  l.created_at,
  l.status_name as стадия_сейчас,
  l.assigned_by_name as ответственный,
  (l.qualified_at is not null) as стал_квалом,
  -- входящие держим отдельно: если человек позвонил сам, исходящий не нужен
  (select count(*) from bfl_lead_calls c
    where c.lead_id = l.lead_id and c.direction = 1 and c.completed)::integer as входящих
from bfl_lead_timings l
where l.source_marker is not null
  and l.source_marker not in (select source_marker from bfl_excluded_sources)
  and not exists (
    select 1 from bfl_lead_calls c
    where c.lead_id = l.lead_id
      and bfl_call_is_attempt(c.direction, c.completed)
  );

-- ============================================================================
-- Где они осели: главный разрез
--
-- Стадия говорит, что с лидом случилось вместо звонка. «Другой регион» и
-- «Ошибочная заявка» — законный отказ без набора. «Не удалось дозвониться»
-- без единой попытки — противоречие, которого быть не должно. Рабочая стадия
-- при нулевом обзвоне — чистая потеря.
-- ============================================================================
drop view if exists bfl_uncalled_by_stage;
create view bfl_uncalled_by_stage with (security_invoker = true) as
select
  coalesce(стадия_сейчас, '— без стадии —') as стадия,
  count(*)::integer as лидов,
  count(*) filter (where входящих > 0)::integer as перезвонили_сами,
  count(*) filter (where стал_квалом)::integer as квалов,
  round(100.0 * count(*) filter (where стал_квалом) / nullif(count(*), 0), 1)
    as конверсия_в_квал,
  round(avg(extract(epoch from (now() - created_at)) / 86400.0))::integer as средний_возраст_дней
from bfl_uncalled_leads
group by 1;

-- ============================================================================
-- По источникам: не окажется ли, что это целиком пара каналов
-- ============================================================================
drop view if exists bfl_uncalled_by_source;
create view bfl_uncalled_by_source with (security_invoker = true) as
with всего as (
  select source_marker, count(*)::integer as лидов_всего
  from bfl_lead_timings
  where source_marker is not null
    and source_marker not in (select source_marker from bfl_excluded_sources)
  group by 1
)
select
  u.source_marker as источник,
  в.лидов_всего,
  count(*)::integer as не_набирали,
  round(100.0 * count(*) / nullif(в.лидов_всего, 0), 1) as доля_необзвоненных,
  count(*) filter (where u.входящих > 0)::integer as перезвонили_сами,
  count(*) filter (where u.стал_квалом)::integer as квалов
from bfl_uncalled_leads u
join всего в on в.source_marker = u.source_marker
group by u.source_marker, в.лидов_всего
having count(*) >= 20;

-- ============================================================================
-- По ответственным: не концентрируется ли утечка на ком-то
--
-- Если необзвоненные распределены по людям ровно — дело в процессе
-- распределения лидов. Если сидят у одного-двух — дело в людях, и это
-- решается разговором, а не перестройкой.
-- ============================================================================
drop view if exists bfl_uncalled_by_manager;
create view bfl_uncalled_by_manager with (security_invoker = true) as
with всего as (
  select coalesce(assigned_by_name, '— не загружен —') as менеджер, count(*)::integer as лидов_всего
  from bfl_lead_timings
  where source_marker is not null
    and source_marker not in (select source_marker from bfl_excluded_sources)
  group by 1
)
select
  coalesce(u.ответственный, '— не загружен —') as менеджер,
  в.лидов_всего,
  count(*)::integer as не_набирали,
  round(100.0 * count(*) / nullif(в.лидов_всего, 0), 1) as доля_необзвоненных,
  count(*) filter (where u.стал_квалом)::integer as квалов
from bfl_uncalled_leads u
join всего в on в.менеджер = coalesce(u.ответственный, '— не загружен —')
group by 1, в.лидов_всего
having count(*) >= 20;

-- ============================================================================
-- По времени: не растёт ли утечка
--
-- Если доля необзвоненных стабильна месяцами — это устоявшийся порядок вещей.
-- Если растёт — отдел перестаёт справляться с потоком, и это другая задача.
-- ============================================================================
drop view if exists bfl_uncalled_by_month;
create view bfl_uncalled_by_month with (security_invoker = true) as
with всего as (
  select date_trunc('month', created_at)::date as месяц, count(*)::integer as лидов_всего
  from bfl_lead_timings
  where source_marker is not null
    and source_marker not in (select source_marker from bfl_excluded_sources)
  group by 1
)
select
  в.месяц,
  в.лидов_всего,
  count(u.lead_id)::integer as не_набирали,
  round(100.0 * count(u.lead_id) / nullif(в.лидов_всего, 0), 1) as доля_необзвоненных
from всего в
left join bfl_uncalled_leads u on date_trunc('month', u.created_at)::date = в.месяц
group by в.месяц, в.лидов_всего;
