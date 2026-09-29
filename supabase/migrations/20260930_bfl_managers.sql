-- ============================================================================
-- Зависимости: разрез по менеджерам и отделам.
--
-- Из 398 зависших квалов 235 висят дольше месяца. Чтобы с этим можно было
-- что-то сделать, нужно знать не «какой источник», а «кто отпустил» — по
-- источнику задачу не поставишь.
--
-- Что добавляется:
--   * ответственный за лид — тот, кто должен разбирать зависшего сейчас;
--   * кто назначил сорвавшуюся встречу и кто проводил консультацию;
--   * отдел МКО — крупный разрез, если по людям картина слишком дробная.
-- ============================================================================

alter table bfl_lead_timings
  add column if not exists assigned_by_id bigint,
  add column if not exists assigned_by_name text;

alter table bfl_meeting_timings
  add column if not exists assigned_by_id bigint,
  add column if not exists assigned_by_name text,
  add column if not exists scheduled_by_name text,
  add column if not exists consulted_by_name text,
  add column if not exists mko_department text;

-- ============================================================================
-- Зависшие квалы по менеджерам
--
-- Лид попадает сюда, если у него есть сорвавшаяся встреча, нет ни одной
-- состоявшейся, ничего не назначено на будущее, и он до сих пор висит на
-- стадии «Назначение встречи» — то есть его не закрыли, а просто забыли.
-- ============================================================================
drop view if exists bfl_stuck_by_manager;
create view bfl_stuck_by_manager with (security_invoker = true) as
with per_lead as (
  select
    lead_id,
    count(*) filter (where stage_id = 'DT1044_64:SUCCESS') as held,
    count(*) filter (where stage_id = 'DT1044_64:FAIL') as failed,
    count(*) filter (where stage_id not in ('DT1044_64:SUCCESS', 'DT1044_64:FAIL')) as pending,
    max(bfl_meeting_moment(scheduled_at, held_at)) as last_met,
    -- Отдел и «кто назначил» берём с САМОЙ ПОЗДНЕЙ встречи лида: именно она
    -- сорвалась последней, с неё и спрос.
    (array_agg(mko_department order by bfl_meeting_moment(scheduled_at, held_at) desc nulls last))[1] as mko,
    (array_agg(scheduled_by_name order by bfl_meeting_moment(scheduled_at, held_at) desc nulls last))[1] as last_scheduled_by
  from bfl_meeting_timings
  where source_marker is not null and lead_id is not null
  group by lead_id
)
select
  coalesce(l.assigned_by_name, '— не загружено —') as ответственный_за_лид,
  coalesce(p.mko, '—') as отдел,
  count(*)::integer as зависло,
  count(*) filter (
    where (current_date - (p.last_met at time zone 'Europe/Moscow')::date) > 30
  )::integer as старше_30_дней,
  round(avg(current_date - (p.last_met at time zone 'Europe/Moscow')::date))::integer as средний_возраст_дней,
  max((p.last_met at time zone 'Europe/Moscow')::date) as последний_срыв
from per_lead p
join bfl_lead_timings l on l.lead_id = p.lead_id
where p.held = 0 and p.pending = 0 and p.failed > 0
  and l.status_name = 'Назначение встречи'
group by 1, 2;

-- ============================================================================
-- Встречи по менеджерам: назначено, состоялось, доходимость
--
-- Разрез по тому, КТО НАЗНАЧАЛ встречу. Отдельно — кто проводил консультацию,
-- но по нему считаются только состоявшиеся: у сорвавшейся встречи проводившего
-- по определению нет.
-- ============================================================================
drop view if exists bfl_meetings_by_manager;
create view bfl_meetings_by_manager with (security_invoker = true) as
select
  coalesce(scheduled_by_name, '— не указан —') as назначил,
  coalesce(mko_department, '—') as отдел,
  count(*)::integer as назначено,
  count(*) filter (where stage_id = 'DT1044_64:SUCCESS')::integer as состоялось,
  count(*) filter (where stage_id = 'DT1044_64:FAIL')::integer as сорвалось,
  round(
    100.0 * count(*) filter (where stage_id = 'DT1044_64:SUCCESS')
    / nullif(count(*) filter (where stage_id in ('DT1044_64:SUCCESS', 'DT1044_64:FAIL')), 0)
  , 1) as доходимость
from bfl_meeting_timings
where source_marker is not null
  and bfl_meeting_moment(scheduled_at, held_at) is not null
group by 1, 2;
