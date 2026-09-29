-- ============================================================================
-- Зависимости: поправка на часовой пояс + доходимость встреч по неделям.
--
-- ПОПРАВКА. Поле ufCrm28Datetime объявлено с USE_TIMEZONE = N, то есть
-- «наивное»: хранит стенные часы как их ввели. Вводят по новосибирскому
-- времени, а Битрикс на выдаче приклеивает к ним московский +03:00. Ярлык
-- врёт, и разобранная строка оказывается на 4 часа позже реального момента
-- (Новосибирск UTC+7 минус Москва UTC+3).
--
-- Проверено не на глаз: у 910 состоявшихся встреч разница между movedTime
-- (настоящая системная отметка) и scheduled_at дала среднее −4,06 ч и медиану
-- −4,11 ч. После поправки расхождение схлопывается примерно в ноль — встречу
-- отмечают в момент её начала, чего и следовало ожидать.
--
-- ДОХОДИМОСТЬ. На каждое назначение встречи создаётся ОТДЕЛЬНАЯ запись в СП
-- (подтверждено: 1213 лидов дали 1636 записей, у четверти лидов встреча
-- назначалась повторно). Поэтому доходимость считается по попыткам:
--   состоялось = стадия SUCCESS («Проведена»)
--   сорвалось  = стадия FAIL («Перенос встречи»)
--   в работе   = всё остальное, встречи с датой в будущем
-- Текущая неделя всегда недосчитана — её «в работе» ещё не разошлось по двум
-- исходам, поэтому колонка показывается отдельно, а не прячется в знаменатель.
-- ============================================================================

-- Настоящий момент встречи. Одна точка правды для всех витрин: поменяется
-- часовой пояс или настройка поля — правится здесь, а не в трёх местах.
create or replace function bfl_meeting_moment(scheduled timestamptz, held timestamptz)
returns timestamptz language sql immutable as $$
  select coalesce(scheduled - interval '4 hours', held);
$$;

-- ============================================================================
-- Витрина замеров времени
-- ============================================================================
drop view if exists bfl_timing_weekly;
create view bfl_timing_weekly with (security_invoker = true) as
with m as (
  select
    bfl_meeting_moment(mt.scheduled_at, mt.held_at) as met_at,
    l.created_at,
    l.qualified_at
  from bfl_meeting_timings mt
  left join bfl_lead_timings l on l.lead_id = mt.lead_id
  where mt.source_marker is not null
    and bfl_meeting_is_held(mt.stage_id)
    and bfl_meeting_moment(mt.scheduled_at, mt.held_at) is not null
),
base as (
  select
    'lead_to_qual'::text as metric,
    (l.qualified_at at time zone 'Europe/Moscow')::date as event_date,
    extract(epoch from (l.qualified_at - l.created_at)) / 3600.0 as hours
  from bfl_lead_timings l
  where l.qualified_at is not null
    and l.qualified_at >= l.created_at

  union all

  select
    'qual_to_meeting',
    (m.met_at at time zone 'Europe/Moscow')::date,
    greatest(extract(epoch from (m.met_at - m.qualified_at)) / 3600.0, 0)
  from m
  where m.created_at is not null
    and m.qualified_at is not null
    and m.met_at >= m.created_at
    and m.met_at >= m.qualified_at - interval '24 hours'

  union all

  select
    'lead_to_meeting',
    (m.met_at at time zone 'Europe/Moscow')::date,
    extract(epoch from (m.met_at - m.created_at)) / 3600.0
  from m
  where m.created_at is not null
    and m.met_at >= m.created_at
)
select
  metric,
  event_date - (extract(dow from event_date)::integer + 3) % 7 as week_start,
  count(*)::integer as n,
  round(avg(hours)::numeric, 1) as avg_hours,
  round((percentile_cont(0.5) within group (order by hours))::numeric, 1) as median_hours,
  round((percentile_cont(0.9) within group (order by hours))::numeric, 1) as p90_hours
from base
group by 1, 2;

-- ============================================================================
-- Охват
-- ============================================================================
drop view if exists bfl_timing_coverage;
create view bfl_timing_coverage with (security_invoker = true) as
with m as (
  select
    bfl_meeting_moment(mt.scheduled_at, mt.held_at) as met_at,
    l.created_at
  from bfl_meeting_timings mt
  left join bfl_lead_timings l on l.lead_id = mt.lead_id
  where mt.source_marker is not null
    and bfl_meeting_is_held(mt.stage_id)
    and bfl_meeting_moment(mt.scheduled_at, mt.held_at) is not null
)
select
  (met_at at time zone 'Europe/Moscow')::date
    - (extract(dow from (met_at at time zone 'Europe/Moscow')::date)::integer + 3) % 7 as week_start,
  count(*)::integer as meetings_total,
  count(*) filter (where created_at is not null and met_at >= created_at)::integer as measured,
  count(*) filter (where created_at is not null and met_at < created_at)::integer as lead_after_meeting,
  count(*) filter (where created_at is null)::integer as lead_missing
from m
group by 1;

-- ============================================================================
-- Доходимость встреч по неделям
-- ============================================================================
drop view if exists bfl_meeting_outcome_weekly;
create view bfl_meeting_outcome_weekly with (security_invoker = true) as
with m as (
  select
    bfl_meeting_moment(scheduled_at, held_at) as met_at,
    stage_id
  from bfl_meeting_timings
  where source_marker is not null
    and bfl_meeting_moment(scheduled_at, held_at) is not null
)
select
  (met_at at time zone 'Europe/Moscow')::date
    - (extract(dow from (met_at at time zone 'Europe/Moscow')::date)::integer + 3) % 7 as week_start,
  count(*)::integer as scheduled,
  count(*) filter (where stage_id = 'DT1044_64:SUCCESS')::integer as held,
  count(*) filter (where stage_id = 'DT1044_64:FAIL')::integer as failed,
  count(*) filter (where stage_id not in ('DT1044_64:SUCCESS', 'DT1044_64:FAIL'))::integer as pending,
  round(
    100.0 * count(*) filter (where stage_id = 'DT1044_64:SUCCESS')
    -- Знаменатель — только отработанные попытки. Встречи «в работе» исхода
    -- ещё не имеют, и если бросить их в знаменатель, текущая неделя всегда
    -- будет выглядеть провальной.
    / nullif(count(*) filter (where stage_id in ('DT1044_64:SUCCESS', 'DT1044_64:FAIL')), 0)
  , 1) as rate
from m
group by 1;
