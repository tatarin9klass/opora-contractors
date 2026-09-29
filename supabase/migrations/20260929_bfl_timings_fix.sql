-- ============================================================================
-- Зависимости: чиним охват замеров.
--
-- Что выяснилось после первой загрузки (907 встреч с 16 июля):
--   * 179 встреч вообще не БФЛ — при импорте встречи брались из смарт-процесса
--     без фильтра по источнику, а он там не только ofbfl-. Реальных встреч БФЛ
--     728. Заодно этим объясняются «встречи без лида»: лид у них есть, просто
--     не из нашего направления и потому не загружен.
--   * 222 встречи из 728 (30%) — лид заведён ПОСЛЕ встречи. Массово у
--     источников со «ЗВ» в названии: позвонили, встретились, лид завели потом.
--     Время тут измерить нельзя в принципе, лида на момент встречи не было.
--   * 55 встреч — квал проставлен позже встречи, но лид был раньше. Это
--     встречи день в день, где галочку поставили вечером.
--
-- Что меняем:
--   1. В витрину попадают только источники ofbfl-.
--   2. Квал позже встречи в пределах суток считается нулём, а не выбрасывается.
--      Выбрасывать нельзя: это самые быстрые случаи, и без них среднее и
--      медиана завышаются.
--   3. Рядом появляется витрина охвата — сколько встреч за неделю измерено и
--      сколько выпало. Без неё по графику не видно, на какой доле реальности
--      построена линия.
-- ============================================================================

drop view if exists bfl_timing_weekly;
create view bfl_timing_weekly with (security_invoker = true) as
with m as (
  select
    mt.held_at,
    l.created_at,
    l.qualified_at
  from bfl_meeting_timings mt
  left join bfl_lead_timings l on l.lead_id = mt.lead_id
  -- source_marker заполняется только для источников ofbfl-; null means встреча
  -- чужого направления.
  where mt.source_marker is not null
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
    (m.held_at at time zone 'Europe/Moscow')::date,
    -- greatest(..., 0): квал, проставленный через несколько часов после
    -- встречи, — это ноль, а не отрицательное число и не повод выкинуть строку.
    greatest(extract(epoch from (m.held_at - m.qualified_at)) / 3600.0, 0)
  from m
  where m.created_at is not null
    and m.qualified_at is not null
    -- лид существовал на момент встречи, иначе мерить нечего
    and m.held_at >= m.created_at
    -- отставание квала больше суток — это уже не «день в день», а битые данные
    and m.held_at >= m.qualified_at - interval '24 hours'

  union all

  select
    'lead_to_meeting',
    (m.held_at at time zone 'Europe/Moscow')::date,
    extract(epoch from (m.held_at - m.created_at)) / 3600.0
  from m
  where m.created_at is not null
    and m.held_at >= m.created_at
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
-- Охват: сколько встреч недели вообще поддаётся замеру.
-- ============================================================================
drop view if exists bfl_timing_coverage;
create view bfl_timing_coverage with (security_invoker = true) as
with m as (
  select
    (mt.held_at at time zone 'Europe/Moscow')::date as held_date,
    mt.held_at,
    l.created_at
  from bfl_meeting_timings mt
  left join bfl_lead_timings l on l.lead_id = mt.lead_id
  where mt.source_marker is not null
)
select
  held_date - (extract(dow from held_date)::integer + 3) % 7 as week_start,
  count(*)::integer as meetings_total,
  count(*) filter (where created_at is not null and held_at >= created_at)::integer as measured,
  count(*) filter (where created_at is not null and held_at < created_at)::integer as lead_after_meeting,
  count(*) filter (where created_at is null)::integer as lead_missing
from m
group by 1;
