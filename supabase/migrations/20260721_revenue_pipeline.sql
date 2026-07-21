-- Дашборд «Дополнительные показатели»: добавляем Revenue (сумма сделок за период)
-- и AOV (revenue / количество сделок). Revenue считается по факту оплаты сделки (тот же день,
-- что уже используется для deals — DEAL_PAID_DATE_FIELD в bitrix-import), сумма
-- берётся из поля сделки OPPORTUNITY.
alter table daily_facts add column if not exists revenue numeric not null default 0;
alter table weekly_snapshots add column if not exists revenue numeric;
alter table monthly_snapshots add column if not exists revenue numeric;

-- ПОПУТНО ИСПРАВЛЕНО: старый weekly_stats джойнил daily_facts с weekly_expenses
-- по (contractor_id, week_start) без учёта того, что daily_facts содержит
-- НЕСКОЛЬКО строк на этот ключ (по одной на источник на день), а weekly_expenses —
-- тоже несколько строк (по одной на источник на неделю). JOIN без предварительной
-- агрегации порождал декартово произведение внутри GROUP BY, и sum(we.spend)
-- получался умноженным на количество строк daily_facts для этого подрядчика/недели.
-- Теперь обе стороны агрегируются до (contractor_id, week_start) СНАЧАЛА,
-- в отдельных подзапросах, и только потом джойнятся 1:1.
create or replace view weekly_stats as
with facts_agg as (
  select
    contractor_id,
    fact_date - (extract(dow from fact_date)::integer + 3) % 7 as week_start,
    sum(leads) as leads,
    sum(quals) as quals,
    sum(meetings) as meetings,
    sum(deals) as deals,
    sum(coalesce(revenue, 0)) as revenue
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
  f.revenue
from facts_agg f
left join expenses_agg e on e.contractor_id = f.contractor_id and e.week_start = f.week_start;
