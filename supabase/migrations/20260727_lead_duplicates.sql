-- Метрика "Дубли" (лиды, автоматически переведённые Битриксом на этап "Дубль"
-- в воронке лидов) — считается с сегодняшнего дня вперёд, историю по прошлым
-- неделям не восстанавливаем (dashboard_historical_weeks эту колонку
-- намеренно не получает — для тех недель % дублей будет показываться как "—",
-- а не как обманчивый 0%).
alter table daily_facts add column if not exists duplicates integer not null default 0;

-- CREATE OR REPLACE VIEW не даёт менять порядок существующих колонок — новая
-- добавлена строго в конец select (см. аналогичный фикс для revenue).
create or replace view weekly_stats as
with facts_agg as (
  select
    contractor_id,
    fact_date - (extract(dow from fact_date)::integer + 3) % 7 as week_start,
    sum(leads) as leads,
    sum(quals) as quals,
    sum(meetings) as meetings,
    sum(deals) as deals,
    sum(coalesce(revenue, 0)) as revenue,
    sum(coalesce(duplicates, 0)) as duplicates
  from daily_facts
  where contractor_id is not null
  group by contractor_id, (fact_date - (extract(dow from fact_date)::integer + 3) % 7)
),
expenses_agg as (
  select contractor_id, week_start, sum(spend) as spend
  from weekly_expenses
  group by contractor_id, week_start
)
select
  f.contractor_id,
  f.week_start,
  f.leads,
  f.quals,
  f.meetings,
  f.deals,
  coalesce(e.spend, 0::numeric) as spend,
  f.revenue,
  f.duplicates
from facts_agg f
left join expenses_agg e on e.contractor_id = f.contractor_id and e.week_start = f.week_start;
