-- ============================================================================
-- Планы на менеджеров ставит РОП. План на отдел — по-прежнему нет.
--
-- ГРАНИЦА ПРОВЕДЕНА ЗДЕСЬ НЕ СЛУЧАЙНО. План отдела — обязательство
-- руководителя отдела перед направлением, и если он сможет его править, то
-- план перестанет быть планом: его всегда можно подогнать под факт. А вот
-- как разложить этот план по людям — работа РОПа, и каждый раз ходить за
-- этим к администратору значит делать планирование ритуалом.
--
-- Поэтому правило простое: строки с фамилией менеджера своего отдела —
-- можно, строка отдела целиком (manager_name is null) — нельзя.
-- ============================================================================

-- Право читать свой отдел. Форма планов работает с таблицей напрямую, а не
-- через витрину кабинета: ей нужны идентификаторы строк, чтобы изменять их
-- на месте, а не создавать дубли.
drop policy if exists "rop_select_own" on rop_plans;
create policy "rop_select_own" on rop_plans for select
  using (is_rop() and team = current_rop_team());

drop policy if exists "rop_write_own_managers" on rop_plans;
create policy "rop_write_own_managers" on rop_plans for all
  using (is_rop() and team = current_rop_team() and manager_name is not null)
  with check (is_rop() and team = current_rop_team() and manager_name is not null);

comment on policy "rop_write_own_managers" on rop_plans is
  'РОП распределяет план по своим менеджерам. Строка отдела целиком '
  '(manager_name is null) остаётся за администратором: иначе обязательство '
  'можно переписать под факт.';

-- Состав своего отдела — нужен форме, чтобы знать, кому ставить планы.
drop policy if exists "rop_select_own_team" on rop_managers;
create policy "rop_select_own_team" on rop_managers for select
  using (is_rop() and team = current_rop_team());

-- ============================================================================
-- Проверка — под почтой РОПа
--
--   begin;
--   select set_config('request.jwt.claims',
--     json_build_object(
--       'sub',  (select id::text from auth.users where email = 'ПОЧТА'),
--       'role', 'authenticated')::text, true);
--   set local role authenticated;
--   select count(*) as видит_планов from rop_plans;
--   select count(*) as видит_менеджеров from rop_managers;
--   rollback;
--
-- Обе цифры должны быть больше нуля и относиться только к своему отделу.
-- ============================================================================
