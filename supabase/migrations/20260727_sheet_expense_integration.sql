-- Автоматизация расхода для источников с типом оплаты "Абонентка + бюджет"
-- через Google Таблицу подрядчика (дата + расход, фиксированные столбцы A:B).
-- expense_mode='manual' (по умолчанию) — как сейчас, ручной ввод бюджета.
-- expense_mode='sheet' — расход берётся из expense_sheet_url при каждом
-- запуске bitrix-import (Edge Function), поле в "Ввод расходов" блокируется,
-- как для Фикс/Абонентка.
alter table sources add column if not exists expense_mode text not null default 'manual';
alter table sources add column if not exists expense_sheet_url text;

do $$ begin
  if not exists (
    select 1 from pg_constraint where conname = 'sources_expense_mode_check'
  ) then
    alter table sources add constraint sources_expense_mode_check check (expense_mode in ('manual', 'sheet'));
  end if;
end $$;
