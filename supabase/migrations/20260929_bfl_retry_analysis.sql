-- ============================================================================
-- Зависимости: работа с сорвавшимися встречами.
--
-- Два вопроса, на которые отвечают витрины ниже:
--   1. На каких неделях менеджеры чаще назначали встречу повторно.
--   2. Сколько квалов после срыва так и остались без новой встречи, и на каких
--      стадиях воронки лидов они сейчас висят.
--
-- Почему это важно. Из 1213 лидов с назначенной встречей дошли 726, причём
-- 173 из них — только со второй попытки или дальше. Переназначение срабатывает
-- в 57,5% случаев, что ВЫШЕ, чем доходимость первой встречи (45,6%). При этом
-- у 359 лидов была ровно одна несостоявшаяся встреча, и повторно их не
-- записывали вовсе.
-- ============================================================================

alter table bfl_lead_timings
  add column if not exists status_id text,
  add column if not exists status_name text;

-- ============================================================================
-- Переназначения по неделям
-- ============================================================================
drop view if exists bfl_meeting_retry_weekly;
create view bfl_meeting_retry_weekly with (security_invoker = true) as
with m as (
  select
    meeting_id,
    lead_id,
    stage_id,
    bfl_meeting_moment(scheduled_at, held_at) as met_at
  from bfl_meeting_timings
  where source_marker is not null
    and lead_id is not null
    and bfl_meeting_moment(scheduled_at, held_at) is not null
),
failed as (
  select
    f.met_at,
    -- Перезаписали: у того же лида есть встреча, назначенная ПОЗЖЕ сорвавшейся.
    exists (
      select 1 from m n
      where n.lead_id = f.lead_id and n.met_at > f.met_at
    ) as retried,
    -- И из перезаписанных — те, что в итоге состоялись.
    exists (
      select 1 from m n
      where n.lead_id = f.lead_id and n.met_at > f.met_at
        and n.stage_id = 'DT1044_64:SUCCESS'
    ) as retried_and_held
  from m f
  where f.stage_id = 'DT1044_64:FAIL'
)
select
  (met_at at time zone 'Europe/Moscow')::date
    - (extract(dow from (met_at at time zone 'Europe/Moscow')::date)::integer + 3) % 7 as week_start,
  count(*)::integer as failed,
  count(*) filter (where retried)::integer as retried,
  count(*) filter (where retried_and_held)::integer as retried_held,
  round(100.0 * count(*) filter (where retried) / nullif(count(*), 0), 1) as retry_rate,
  round(
    100.0 * count(*) filter (where retried_and_held)
    / nullif(count(*) filter (where retried), 0)
  , 1) as retry_success_rate
from failed
group by 1;

-- ============================================================================
-- Квалы, оставшиеся без повторной встречи
--
-- Лид попадает сюда, если у него есть сорвавшаяся встреча, нет ни одной
-- состоявшейся и ничего не назначено на будущее. Разрез по текущей стадии
-- лида показывает, кого ещё можно вернуть (висит в «Назначении встречи»),
-- а кого закрыли осознанно.
-- ============================================================================
drop view if exists bfl_leads_without_retry;
create view bfl_leads_without_retry with (security_invoker = true) as
with per_lead as (
  select
    lead_id,
    count(*) filter (where stage_id = 'DT1044_64:SUCCESS') as held,
    count(*) filter (where stage_id = 'DT1044_64:FAIL') as failed,
    count(*) filter (where stage_id not in ('DT1044_64:SUCCESS', 'DT1044_64:FAIL')) as pending,
    max(bfl_meeting_moment(scheduled_at, held_at)) as last_met
  from bfl_meeting_timings
  where source_marker is not null and lead_id is not null
  group by lead_id
)
select
  coalesce(l.status_name, l.status_id, '— стадия не загружена —') as стадия_лида,
  count(*)::integer as лидов,
  min(p.last_met) as самый_ранний_срыв,
  max(p.last_met) as самый_поздний_срыв
from per_lead p
join bfl_lead_timings l on l.lead_id = p.lead_id
where p.held = 0 and p.pending = 0 and p.failed > 0
group by 1;
