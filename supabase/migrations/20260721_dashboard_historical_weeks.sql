-- Историческая сводка по неделям (ISO-недели 23-28 2026), присланная вручную —
-- НЕ в разрезе подрядчиков, только агрегат по компании целиком. Показывается
-- только на дашборде (карточки + "Динамика по неделям") — ContractorsPage и
-- PassportPage читают weekly_stats напрямую и эту таблицу не видят вообще.
-- Данные считаются зафиксированными навсегда (не пересчитываются, в отличие
-- от live-недель) — по сути постоянный "замороженный" ряд, без необходимости
-- проводить через обычный механизм заморозки (weekly_snapshots), потому что
-- за этими неделями в принципе нет daily_facts/weekly_expenses.
create table if not exists dashboard_historical_weeks (
  week_start date primary key,
  spend numeric not null default 0,
  leads integer not null default 0,
  quals integer not null default 0,
  meetings integer not null default 0,
  deals integer not null default 0,
  revenue numeric not null default 0,
  entered_at timestamptz not null default now()
);

alter table dashboard_historical_weeks enable row level security;
drop policy if exists "authenticated_select" on dashboard_historical_weeks;
create policy "authenticated_select" on dashboard_historical_weeks for select using (auth.uid() is not null);
drop policy if exists "admin_write" on dashboard_historical_weeks;
create policy "admin_write" on dashboard_historical_weeks for all using (is_admin()) with check (is_admin());

insert into dashboard_historical_weeks (week_start, spend, leads, quals, meetings, deals, revenue) values
  ('2026-06-04', 1058513, 800, 197, 78, 19, 4272000),
  ('2026-06-11',  822124, 743, 163, 70, 23, 4583000),
  ('2026-06-18', 1000887, 763, 182, 78, 13, 3294000),
  ('2026-06-25', 1102944, 811, 179, 83, 18, 3754000),
  ('2026-07-02', 1011446, 787, 172, 70,  9, 1490000),
  ('2026-07-09',  993999, 787, 194, 83, 23, 5018000)
on conflict (week_start) do update set
  spend = excluded.spend, leads = excluded.leads, quals = excluded.quals,
  meetings = excluded.meetings, deals = excluded.deals, revenue = excluded.revenue;
