-- ============================================================================
-- Роль РОПа и его доступ.
--
-- УСТРОЙСТВО ТО ЖЕ, ЧТО У КАБИНЕТА ПОДРЯДЧИКА, И ПО ТОЙ ЖЕ ПРИЧИНЕ. РОП не
-- получает политик ни на одной базовой таблице — он видит несколько вьюх
-- rop_portal_*, каждая из которых сама решает, что отдавать. Дать ему select
-- на rop_deals означало бы отдать и сделки чужого отдела: таблица общая, в
-- ней работают менеджеры другого руководителя.
--
-- Вьюхи без security_invoker здесь законны ровно по той же причине, что и у
-- подрядчика: они обязаны читать таблицы, к которым у роли доступа нет, и
-- фильтруют сами — по составу отдела в rop_managers.
--
-- ЧТО РОП ВИДИТ: показатели своего отдела и своих менеджеров, планы на
-- месяц, даты появления этапов воронки. Чего не видит: сделки чужих
-- отделов, направление БФЛ в управленческом учёте, расходы, подрядчиков,
-- Автоправо — ничего из этого нет в его вьюхах.
-- ============================================================================

alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('admin', 'viewer', 'contractor', 'rop'));

-- Привязка к подрядчику обязательна только для роли contractor. У РОПа её
-- быть не должно — иначе он получит ещё и кабинет подрядчика.
alter table profiles drop constraint if exists profiles_contractor_link_check;
alter table profiles add constraint profiles_contractor_link_check check (
  (role = 'contractor' and contractor_id is not null)
  or (role <> 'contractor' and contractor_id is null)
);

create or replace function is_rop()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'rop');
$$;

comment on function is_rop() is
  'Залогинен руководитель отдела продаж. Роль видит только показатели '
  'своего отдела и ничего больше.';

-- ============================================================================
-- Кто смотрит
--
-- Сотрудники (admin, viewer) видят те же экраны — им это не мешает и
-- позволяет проверить, что показано руководителю, не входя под его логином.
-- ============================================================================
create or replace function rop_can_read()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role in ('admin', 'viewer', 'rop')
  );
$$;

-- ============================================================================
-- Показатели отдела по дням
-- ============================================================================
drop view if exists rop_portal_daily;
create view rop_portal_daily as
select d.*
from rop_daily d
where rop_can_read();

revoke all on rop_portal_daily from anon;
grant select on rop_portal_daily to authenticated;

-- ============================================================================
-- Показатели по менеджерам
-- ============================================================================
drop view if exists rop_portal_manager;
create view rop_portal_manager as
select d.*
from rop_daily_manager d
where rop_can_read();

revoke all on rop_portal_manager from anon;
grant select on rop_portal_manager to authenticated;

-- ============================================================================
-- Планы
--
-- РОП их видит, но не меняет: планы ставит руководитель направления, как и
-- для подрядчиков. Запись остаётся за админом — политика admin_write на
-- rop_plans уже стоит.
-- ============================================================================
drop view if exists rop_portal_plans;
create view rop_portal_plans as
select p.period, p.manager_name, p.metric, p.value
from rop_plans p
where rop_can_read();

revoke all on rop_portal_plans from anon;
grant select on rop_portal_plans to authenticated;

-- ============================================================================
-- С какого дня существует каждый этап
--
-- Нужна экрану, чтобы за период до появления этапа показать не ноль, а
-- прочерк с пояснением. Ноль руководитель прочитает как провал отдела.
-- ============================================================================
drop view if exists rop_portal_stage_since;
create view rop_portal_stage_since as
select s.*
from rop_stage_since s
where rop_can_read();

revoke all on rop_portal_stage_since from anon;
grant select on rop_portal_stage_since to authenticated;

-- ============================================================================
-- Состав отдела
-- ============================================================================
drop view if exists rop_portal_managers;
create view rop_portal_managers as
select m.manager_name, m.sort_order
from rop_managers m
where m.active and rop_can_read();

revoke all on rop_portal_managers from anon;
grant select on rop_portal_managers to authenticated;

-- ============================================================================
-- Как завести РОПа
--
-- 1. Supabase Dashboard → Authentication → Users → Add user, «Auto confirm
--    user» включить.
-- 2. Привязать роль:
--
--    insert into profiles (id, email, role)
--    select u.id, u.email, 'rop' from auth.users u
--    where u.email = 'ПОЧТА'
--    on conflict (id) do update set role = 'rop', contractor_id = null;
--
-- 3. Проверить, что он видит ровно своё:
--
--    select * from rop_scope_check;        -- отдел против чужих
--    select * from portal_security_audit;  -- пусто
-- ============================================================================
