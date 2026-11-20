-- Полная стоимость всех заключённых договоров из Bitrix OPPORTUNITY.
-- paid_at = UF_CRM_1744372636: дата входа в «Полная / частичная оплата».
-- Период и устранение копий совпадают с 20261113_rop_dedup_copies.sql.
-- Применить перед выпуском интерфейса. Старые витрины и планы сохраняются.
begin;

create or replace view public.rop_contract_amounts as
with cards as (
  select d.deal_id, d.lead_id, d.assigned_by_name, d.source_name, d.opportunity,
    (d.paid_at at time zone 'Europe/Moscow')::date as paid_date,
    coalesce(public.rop_client_key(d.title), 'сделка ' || d.deal_id) as client_key
  from public.rop_deals d
  where d.category_id = 34 and d.paid_at is not null
), contracts as (
  select distinct on (client_key, paid_date) *
  from cards
  order by client_key, paid_date, (lead_id is null), deal_id
)
select c.paid_date as дата, m.team as отдел,
  m.manager_name as менеджер, m.active as работает,
  public.rop_source_group(c.source_name) as группа,
  coalesce(sum(c.opportunity), 0)::numeric as сумма_договоров,
  count(*)::integer as договоров,
  count(*) filter (where c.opportunity is null)::integer as договоров_без_суммы
from contracts c
join public.rop_managers m on m.manager_name = c.assigned_by_name and m.team is not null
group by 1, 2, 3, 4, 5;

revoke all on public.rop_contract_amounts from public, anon, authenticated;

-- Как и остальные rop_portal_*: доступ к базе через владельца view,
-- обязательная проверка роли и отдела внутри view. Только агрегаты.
create or replace view public.rop_portal_contract_amounts
with (security_barrier = true) as
select a.* from public.rop_contract_amounts a
where public.rop_can_read()
  and (public.is_staff() or a.отдел = public.current_rop_team());

revoke all on public.rop_portal_contract_amounts from public, anon, authenticated;
grant select on public.rop_portal_contract_amounts to authenticated;

alter table public.rop_plans drop constraint if exists rop_plans_metric_check;
alter table public.rop_plans add constraint rop_plans_metric_check check (
  metric in ('оксвсего', 'оксаз', 'оксвки', 'встречи', 'среднийчек', 'бракнорма', 'договоры_сумма')
);
alter table public.rop_plans drop constraint if exists rop_plans_contract_amount_check;
alter table public.rop_plans add constraint rop_plans_contract_amount_check check (
  metric <> 'договоры_сумма' or
  (manager_name is not null and value >= 0 and value not in ('NaN'::numeric, 'Infinity'::numeric, '-Infinity'::numeric) and value = round(value, 2))
);

comment on view public.rop_portal_contract_amounts is
  'Полная сумма OPPORTUNITY всех договоров по дате оплаты (Москва), без копий; только доступный отдел.';
notify pgrst, 'reload schema';
commit;
