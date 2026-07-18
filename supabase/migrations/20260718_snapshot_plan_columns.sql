-- ТЗ раздел 9: в снапшот копируются не только факты, но и плановые значения,
-- действовавшие на момент заморозки — иначе редактирование плана задним
-- числом незаметно исказит историческую картину отклонений.
-- Таблицы weekly_snapshots/monthly_snapshots уже существуют без этих колонок —
-- просто добавляем их (безопасно, ничего не ломает).

alter table weekly_snapshots
  add column if not exists plan_spend numeric,
  add column if not exists plan_leads integer,
  add column if not exists plan_quals integer,
  add column if not exists plan_meetings integer,
  add column if not exists plan_deals integer;

alter table monthly_snapshots
  add column if not exists plan_spend numeric,
  add column if not exists plan_leads integer,
  add column if not exists plan_quals integer,
  add column if not exists plan_meetings integer,
  add column if not exists plan_deals integer;
