-- Ещё один способ автоматизации расхода "Абонентка + бюджет" — напрямую из
-- кабинета Яндекс Директа подрядчика (у каждого подрядчика свой отдельный
-- кабинет, агентского аккаунта нет), через личный OAuth-токен подрядчика.
alter table sources add column if not exists expense_yandex_token text;

do $$ begin
  alter table sources drop constraint if exists sources_expense_mode_check;
  alter table sources add constraint sources_expense_mode_check
    check (expense_mode in ('manual', 'sheet', 'yandex_direct'));
end $$;
