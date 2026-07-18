-- ТЗ раздел 5.2: план подрядчика — новая сущность, не месячная (вводится один раз
-- при создании подрядчика, дальше редактируется вручную по мере необходимости).
-- Только 5 базовых метрик, без производных (CPL/CPQL/CAC/CR считаются на лету).
--
-- Перед применением проверь тип contractors.id — миграция написана в
-- предположении uuid (так использует весь остальной код в contractor_id).
-- Если у тебя другой тип, поправь строку "contractor_id uuid" ниже.

create table if not exists contractor_targets (
  contractor_id uuid primary key references contractors(id) on delete cascade,
  plan_spend    numeric,
  plan_leads    integer,
  plan_quals    integer,
  plan_meetings integer,
  plan_deals    integer,
  updated_at    timestamptz not null default now(),
  updated_by    text
);

comment on table contractor_targets is
  'План подрядчика (ТЗ раздел 5.2) — вводится один раз при создании подрядчика, '
  'редактируется вручную. В отличие от monthly_targets, не имеет измерения "месяц".';

-- Если в проекте включён RLS для остальных таблиц (contractors, sources и т.д.),
-- добавь сюда аналогичную политику. Пример — открытый доступ для anon/authenticated,
-- как, судя по коду, устроено для остальных таблиц приложения:
--
-- alter table contractor_targets enable row level security;
-- create policy "contractor_targets_all" on contractor_targets
--   for all using (true) with check (true);
