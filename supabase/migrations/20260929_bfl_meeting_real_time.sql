-- ============================================================================
-- Зависимости: переход на реальное время встречи + импорт всех стадий СП.
--
-- ПОЧЕМУ. Поле closedate у смарт-процесса встреч имеет тип `date` — времени в
-- нём нет вообще, значения приходят полночью. Проверено на записи 214:
--   closedate       = 2025-03-30T03:00:00  (то есть просто «30 марта»)
--   ufCrm28Datetime = 2025-03-30T13:00:00  («Дата и время назначенной встречи»)
-- Встреча была в 13:00, а замер считался до 03:00 — десять часов мимо на одной
-- записи. Отсюда же брались «отрицательные» интервалы, когда квал проставлен
-- утром, а встреча в тот же день: она оказывалась «раньше» квала.
--
-- Поэтому моментом встречи становится ufCrm28Datetime, а closedate остаётся
-- запасным вариантом, если поле почему-то не заполнено.
--
-- Заодно импорт перестаёт фильтровать встречи по стадии «успех»: сейчас видно
-- только 40% (состоявшиеся), а назначенные и отменённые не видно вовсе —
-- значит доходимость посчитать нечем. Стадию теперь храним и разбираем потом,
-- по факту, а не угадываем список стадий заранее.
-- ============================================================================

alter table bfl_meeting_timings
  add column if not exists scheduled_at timestamptz,
  add column if not exists created_time timestamptz,
  add column if not exists moved_time timestamptz,
  add column if not exists stage_id text,
  add column if not exists status_text text;

-- held_at (closedate) у неоконченных встреч может быть пустым — раньше сюда
-- попадали только успешные, и NOT NULL был безопасен.
alter table bfl_meeting_timings alter column held_at drop not null;

create index if not exists bfl_meeting_timings_stage_idx on bfl_meeting_timings(stage_id);
create index if not exists bfl_meeting_timings_scheduled_idx on bfl_meeting_timings(scheduled_at);

-- Стадия «успех» в СП встреч. Вынесена в функцию, чтобы не размазывать
-- константу по трём витринам.
create or replace function bfl_meeting_is_held(stage text)
returns boolean language sql immutable as $$
  select stage = 'DT1044_64:SUCCESS';
$$;

-- ============================================================================
-- Витрина замеров времени
-- ============================================================================
drop view if exists bfl_timing_weekly;
create view bfl_timing_weekly with (security_invoker = true) as
with m as (
  select
    -- Момент встречи: сначала настоящее время из ufCrm28Datetime, и только
    -- если его нет — дата из closedate.
    coalesce(mt.scheduled_at, mt.held_at) as met_at,
    l.created_at,
    l.qualified_at
  from bfl_meeting_timings mt
  left join bfl_lead_timings l on l.lead_id = mt.lead_id
  -- source_marker заполнен только для источников ofbfl-; null — чужое направление
  where mt.source_marker is not null
    and bfl_meeting_is_held(mt.stage_id)
    and coalesce(mt.scheduled_at, mt.held_at) is not null
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
    (coalesce(mt.scheduled_at, mt.held_at) at time zone 'Europe/Moscow')::date as met_date,
    coalesce(mt.scheduled_at, mt.held_at) as met_at,
    l.created_at
  from bfl_meeting_timings mt
  left join bfl_lead_timings l on l.lead_id = mt.lead_id
  where mt.source_marker is not null
    and bfl_meeting_is_held(mt.stage_id)
    and coalesce(mt.scheduled_at, mt.held_at) is not null
)
select
  met_date - (extract(dow from met_date)::integer + 3) % 7 as week_start,
  count(*)::integer as meetings_total,
  count(*) filter (where created_at is not null and met_at >= created_at)::integer as measured,
  count(*) filter (where created_at is not null and met_at < created_at)::integer as lead_after_meeting,
  count(*) filter (where created_at is null)::integer as lead_missing
from m
group by 1;

-- ============================================================================
-- Разбор стадий СП — что вообще лежит в смарт-процессе.
--
-- Список стадий заранее не известен (известны только NEW и SUCCESS), поэтому
-- не угадываем, а смотрим по факту: какие стадии встречаются, сколько записей,
-- за какой период. По этой витрине и определим, что считать «отменённой»
-- встречей, прежде чем строить доходимость.
-- ============================================================================
drop view if exists bfl_meeting_stages;
create view bfl_meeting_stages with (security_invoker = true) as
select
  stage_id,
  status_text,
  count(*)::integer as записей,
  count(*) filter (where source_marker is not null)::integer as из_них_бфл,
  min(coalesce(scheduled_at, held_at)) as первая,
  max(coalesce(scheduled_at, held_at)) as последняя
from bfl_meeting_timings
group by 1, 2;

-- ============================================================================
-- Сколько записей СП приходится на один лид — тот самый вопрос про
-- переназначение встреч. Ответ берём из данных, а не подбором примера руками.
-- ============================================================================
drop view if exists bfl_meetings_per_lead;
create view bfl_meetings_per_lead with (security_invoker = true) as
select
  cnt as записей_на_лид,
  count(*)::integer as лидов
from (
  select lead_id, count(*)::integer as cnt
  from bfl_meeting_timings
  where lead_id is not null and source_marker is not null
  group by lead_id
) t
group by 1;
