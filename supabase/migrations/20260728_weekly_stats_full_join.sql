-- ИСПРАВЛЕНО: weekly_stats строился "от лидов" (facts_agg слева, expenses_agg
-- джойнился) — если у подрядчика за неделю не было НИ ОДНОГО лида/квала/
-- встречи/сделки, для этой недели в daily_facts вообще нет строк, и вся
-- неделя целиком выпадала из weekly_stats вместе с расходом. Подтверждено на
-- практике: расход через Google Таблицу записался в weekly_expenses (6 недель
-- успешно обновлено), но нигде не отображался — ни на дашборде, ни в
-- Подрядчиках/Паспорте/РМ, всё читает именно эту view.
-- Теперь ключи (contractor_id, week_start) берутся из ОБЕИХ таблиц через
-- union — неделя видна, даже если есть только расход без лидов (или только
-- лиды без расхода, как было раньше).
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
),
keys as (
  select contractor_id, week_start from facts_agg
  union
  select contractor_id, week_start from expenses_agg
)
select
  k.contractor_id,
  k.week_start,
  coalesce(f.leads, 0) as leads,
  coalesce(f.quals, 0) as quals,
  coalesce(f.meetings, 0) as meetings,
  coalesce(f.deals, 0) as deals,
  coalesce(e.spend, 0::numeric) as spend,
  coalesce(f.revenue, 0) as revenue,
  coalesce(f.duplicates, 0) as duplicates
from keys k
left join facts_agg f on f.contractor_id = k.contractor_id and f.week_start = k.week_start
left join expenses_agg e on e.contractor_id = k.contractor_id and e.week_start = k.week_start;
