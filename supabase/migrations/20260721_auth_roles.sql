-- Доступы с логином/паролем (Supabase Auth). Admin (владелец) — полный доступ,
-- как сейчас. Сотрудники — роль "viewer": видят все данные, ничего не могут
-- изменить. Роль хранится в отдельной таблице profiles (не в user_metadata —
-- его может редактировать сам пользователь через клиент, это было бы дырой).
--
-- !!! ВАЖНО ПЕРЕД ЗАПУСКОМ !!!
-- Эта миграция включает RLS (row level security) на всех таблицах с данными
-- приложения. С этого момента ЛЮБОЕ чтение требует авторизации — если открыть
-- приложение без логина, всё будет выглядеть пустым (не сломанным, а именно
-- пустым — данные скрыты RLS). Поэтому сразу после выполнения этого SQL нужно:
--   1) Создать себе пользователя в Supabase Dashboard → Authentication → Users → Add user
--   2) Выполнить ВТОРОЙ запрос ниже (промаркирован "ШАГ 2"), подставив свой email,
--      чтобы твой аккаунт получил роль admin
--   3) Задеплоить фронтенд с экраном входа (bundle с этим же пакетом изменений)
-- Не откладывай эти шаги — иначе временно не будет доступа к собственному приложению.

create table if not exists profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  email text,
  role text not null default 'viewer' check (role in ('admin', 'viewer')),
  created_at timestamptz not null default now()
);

alter table profiles enable row level security;

drop policy if exists "profiles_select_own" on profiles;
create policy "profiles_select_own" on profiles for select using (auth.uid() = id);

-- security definer — чтобы функцию можно было безопасно вызывать внутри
-- политик других таблиц независимо от прав вызывающего на саму profiles.
create or replace function is_admin()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from profiles where id = auth.uid() and role = 'admin'
  );
$$;

-- Все таблицы с данными приложения: SELECT разрешён любому залогиненному
-- (admin или viewer), запись (insert/update/delete) — только admin.
-- Bitrix-импорт (Edge Function) пишет через service_role — он RLS не подчиняется,
-- поэтому автоматический импорт продолжит работать без каких-либо изменений.
do $$
declare
  tbl text;
  tables text[] := array[
    'contractors', 'sources', 'contractor_types', 'contractor_statuses',
    'contractor_targets', 'payment_types', 'daily_facts', 'weekly_expenses',
    'weekly_snapshots', 'monthly_snapshots', 'monthly_targets',
    'management_decisions', 'decision_types', 'contractor_files',
    'unmatched_sources', 'status_change_reasons', 'status_history', 'weekly_facts'
  ];
begin
  foreach tbl in array tables loop
    execute format('alter table if exists %I enable row level security', tbl);
    execute format('drop policy if exists "authenticated_select" on %I', tbl);
    execute format('create policy "authenticated_select" on %I for select using (auth.uid() is not null)', tbl);
    execute format('drop policy if exists "admin_write" on %I', tbl);
    execute format('create policy "admin_write" on %I for all using (is_admin()) with check (is_admin())', tbl);
  end loop;
end $$;

-- ШАГ 2 — выполнить ОТДЕЛЬНО, после того как создашь себе пользователя в
-- Dashboard → Authentication → Users. Подставь свой реальный email вместо
-- 'ТВОЙ_EMAIL@example.com'. Без этого шага после включения RLS ты не увидишь
-- в приложении вообще ничего, даже после логина.
--
-- insert into profiles (id, email, role)
-- select id, email, 'admin' from auth.users where email = 'ТВОЙ_EMAIL@example.com'
-- on conflict (id) do update set role = 'admin';

-- Для каждого сотрудника (после того как создашь его в Dashboard так же, как
-- себя) — тот же запрос, но с role = 'viewer' и его email:
--
-- insert into profiles (id, email, role)
-- select id, email, 'viewer' from auth.users where email = 'EMPLOYEE@example.com'
-- on conflict (id) do update set role = 'viewer';
