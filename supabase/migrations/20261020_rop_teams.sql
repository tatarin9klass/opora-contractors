-- ============================================================================
-- Два отдела продаж вместо одного.
--
-- ЧТО БЫЛО. Витрины считали только людей Измайлова, а всех остальных
-- отбрасывали как «чужих». Это было правильно, пока кабинет был один: иначе
-- руководитель открыл бы дашборд и принял результат всей компании за свой.
--
-- ЧТО СТАЛО НУЖНО. Второй отдел — тоже наш, и смотреть его надо так же.
-- Но смотреть ОТДЕЛЬНО: у каждого РОПа свой кабинет со своими людьми, а
-- общая картина — у руководителя направления.
--
-- КАК УСТРОЕНО. У менеджера появляется отдел. У вьюх кабинета — измерение
-- «отдел». Роль rop видит строки только своего отдела, сотрудники (admin,
-- viewer) — все, с переключателем на экране. Фильтрация стоит в тех же
-- вьюхах rop_portal_*, что и раньше: одно место, где решается, кому что
-- показывать.
--
-- ПОЧЕМУ СОСТАВ ЗАПОЛНЯЕТСЯ ЗАПРОСОМ, А НЕ СПИСКОМ. Фамилия должна
-- совпадать с тем, как её отдаёт Битрикс, до буквы: «Лаврик О.» и
-- «Лаврик Ольга» — два разных человека для джойна, и один из них потеряет
-- все свои сделки молча. Поэтому имена берутся из самих сделок, а списком
-- задаётся только фамилия.
-- ============================================================================

-- --- Справочник отделов ------------------------------------------------------
create table if not exists rop_teams (
  team text primary key,
  title text not null,
  sort_order integer not null default 100,
  active boolean not null default true
);

insert into rop_teams (team, title, sort_order) values
  ('izmailov', 'Отдел Измайлова', 10),
  ('krivchikova', 'Отдел Кривчиковой', 20)
on conflict (team) do update set title = excluded.title, sort_order = excluded.sort_order;

alter table rop_teams enable row level security;
drop policy if exists "staff_select" on rop_teams;
create policy "staff_select" on rop_teams for select using (is_staff());
drop policy if exists "admin_write" on rop_teams;
create policy "admin_write" on rop_teams for all using (is_admin()) with check (is_admin());

-- --- Принадлежность менеджера к отделу ---------------------------------------
alter table rop_managers
  add column if not exists team text references rop_teams(team);

comment on column rop_managers.team is
  'Чей это менеджер. NULL означает «не распределён» — такой человек не '
  'попадёт ни в один кабинет, и его видно в rop_scope_check.';

-- Отдел Измайлова — имена уже заведены и проверены.
update rop_managers set team = 'izmailov'
where manager_name in ('Измайлов Руслан', 'Черных Елена', 'Лисечко Дмитрий', 'Варламова Светлана');

-- Отдел Кривчиковой — имена берём из самих сделок, чтобы совпали посимвольно.
insert into rop_managers (manager_name, team, sort_order, active)
select distinct d.assigned_by_name, 'krivchikova', 100, true
from rop_deals d
where d.assigned_by_name is not null
  and d.assigned_by_name ~ '^(Кривчикова|Лаврик|Панова|Тунякина|Расстегаев)\s'
on conflict (manager_name) do update
  set team = excluded.team;

-- Расстегаев уволен: прошлые сделки остаются в истории, в текущих
-- показателях его больше нет.
update rop_managers set active = false where manager_name like 'Расстегаев%';

-- Порядок в таблице менеджеров: руководитель первым, остальные по алфавиту.
update rop_managers set sort_order = 5  where manager_name like 'Измайлов%';
update rop_managers set sort_order = 5  where manager_name like 'Кривчикова%';
update rop_managers set sort_order = 20 where sort_order = 100 and team is not null;

-- --- Какой отдел у залогиненного РОПа ----------------------------------------
alter table profiles add column if not exists rop_team text references rop_teams(team);

comment on column profiles.rop_team is
  'Для роли rop — каким отделом он руководит. Кабинет покажет только его.';

create or replace function current_rop_team()
returns text
language sql
security definer
set search_path = public
stable
as $$
  select p.rop_team from profiles p
  where p.id = auth.uid() and p.role = 'rop' and p.rop_team is not null;
$$;

comment on function current_rop_team() is
  'Отдел залогиненного руководителя. NULL у сотрудников — им видно всё.';

-- ============================================================================
-- Витрины получают измерение «отдел»
--
-- Отдел добавляется в группировку, а не в фильтр: отфильтровать можно и
-- снаружи, а вот восстановить разрез, которого нет в данных, — нельзя.
-- ============================================================================
drop view if exists rop_daily cascade;
create view rop_daily as
select
  e.дата,
  m.team as отдел,
  e.группа,
  count(*) filter (where e.stage_id = 'C34:NEW')::integer as встречи,
  count(*) filter (where e.stage_id = 'C34:7')::integer as брак,
  count(*) filter (where e.stage_id = 'C34:PREPARATION')::integer as икп,
  count(*) filter (where e.stage_id = 'C34:PREPAYMENT_INVOIC')::integer as договор_без_оплаты,
  count(*) filter (where e.stage_id = 'C34:UC_1KT09S')::integer as оплата,
  count(*) filter (where e.stage_id = 'C34:WON')::integer as окс_всего,
  count(*) filter (where e.stage_id = 'C34:WON' and e.есть_аз)::integer as окс_аз,
  count(*) filter (where e.stage_id = 'C34:WON' and e.есть_вки)::integer as окс_вки,
  count(*) filter (where e.stage_id = 'C34:WON' and e.есть_бфл)::integer as окс_бфл,
  sum(e.чек) filter (where e.stage_id = 'C34:WON')::numeric as чек_сумма,
  count(*) filter (where e.stage_id = 'C34:WON' and e.чек is not null)::integer as чек_сделок,
  sum(e.фпа) filter (where e.stage_id = 'C34:WON')::numeric as фпа_сумма
from rop_events e
join rop_managers m on m.manager_name = e.менеджер and m.active and m.team is not null
group by e.дата, m.team, e.группа;

drop view if exists rop_daily_manager cascade;
create view rop_daily_manager as
select
  e.дата,
  m.team as отдел,
  e.менеджер,
  e.группа,
  count(*) filter (where e.stage_id = 'C34:NEW')::integer as встречи,
  count(*) filter (where e.stage_id = 'C34:7')::integer as брак,
  count(*) filter (where e.stage_id = 'C34:PREPARATION')::integer as икп,
  count(*) filter (where e.stage_id = 'C34:PREPAYMENT_INVOIC')::integer as договор_без_оплаты,
  count(*) filter (where e.stage_id = 'C34:UC_1KT09S')::integer as оплата,
  count(*) filter (where e.stage_id = 'C34:WON')::integer as окс_всего,
  count(*) filter (where e.stage_id = 'C34:WON' and e.есть_аз)::integer as окс_аз,
  count(*) filter (where e.stage_id = 'C34:WON' and e.есть_вки)::integer as окс_вки,
  sum(e.чек) filter (where e.stage_id = 'C34:WON' and e.есть_бфл)::numeric as чек_бфл_сумма,
  count(*) filter (where e.stage_id = 'C34:WON' and e.есть_бфл and e.чек is not null)::integer as чек_бфл_сделок,
  m.sort_order
from rop_events e
join rop_managers m on m.manager_name = e.менеджер and m.active and m.team is not null
group by e.дата, m.team, e.менеджер, e.группа, m.sort_order;

-- Внутренние витрины клиентам не выдаются: читают их только обёртки
-- rop_portal_*. См. 20261019_rop_portal_chain.sql.
revoke all on rop_daily from anon, authenticated;
revoke all on rop_daily_manager from anon, authenticated;

-- ============================================================================
-- Планы — теперь тоже по отделам
--
-- План на отдел и план на менеджера жили в одной таблице и различались по
-- manager_name. С двумя отделами этого мало: «план на отдел» без указания,
-- на какой именно, превращается в кашу.
-- ============================================================================
alter table rop_plans add column if not exists team text references rop_teams(team);

-- Всё, что заведено до появления второго отдела, принадлежит первому:
-- другого тогда просто не было.
update rop_plans set team = 'izmailov' where team is null;

drop index if exists rop_plans_key_idx;
create unique index if not exists rop_plans_key_idx
  on rop_plans(team, period, coalesce(manager_name, ''), metric);

-- ============================================================================
-- Кабинет: роль rop видит свой отдел, сотрудники — все
-- ============================================================================
drop view if exists rop_portal_daily;
create view rop_portal_daily as
select d.*
from rop_daily d
where rop_can_read()
  and (is_staff() or d.отдел = current_rop_team());

revoke all on rop_portal_daily from anon;
grant select on rop_portal_daily to authenticated;

drop view if exists rop_portal_manager;
create view rop_portal_manager as
select d.*
from rop_daily_manager d
where rop_can_read()
  and (is_staff() or d.отдел = current_rop_team());

revoke all on rop_portal_manager from anon;
grant select on rop_portal_manager to authenticated;

drop view if exists rop_portal_plans;
create view rop_portal_plans as
select p.team as отдел, p.period, p.manager_name, p.metric, p.value
from rop_plans p
where rop_can_read()
  and (is_staff() or p.team = current_rop_team());

revoke all on rop_portal_plans from anon;
grant select on rop_portal_plans to authenticated;

drop view if exists rop_portal_managers;
create view rop_portal_managers as
select m.manager_name, m.team as отдел, m.sort_order
from rop_managers m
where m.active and m.team is not null and rop_can_read()
  and (is_staff() or m.team = current_rop_team());

revoke all on rop_portal_managers from anon;
grant select on rop_portal_managers to authenticated;

-- Список отделов, которые вправе смотреть вошедший. У РОПа он из одной
-- строки — переключателя на экране просто не будет.
drop view if exists rop_portal_teams;
create view rop_portal_teams as
select t.team as отдел, t.title as название, t.sort_order
from rop_teams t
where t.active and rop_can_read()
  and (is_staff() or t.team = current_rop_team());

revoke all on rop_portal_teams from anon;
grant select on rop_portal_teams to authenticated;

-- ============================================================================
-- Проверка охвата: кто куда попал и кто остался без отдела
--
-- Третья строка — самая важная. Если в ней кто-то есть, его сделки не видно
-- ни в одном кабинете, и узнать об этом лучше здесь, чем из вопроса «а
-- почему у меня встреч меньше, чем я помню».
-- ============================================================================
drop view if exists rop_scope_check;
create view rop_scope_check with (security_invoker = true) as
select
  coalesce(t.title, case when m.manager_name is null then 'не заведён в составе'
                         else 'заведён, но без отдела' end) as отдел,
  count(*) filter (where e.stage_id = 'C34:NEW')::integer as встречи,
  count(*) filter (where e.stage_id = 'C34:WON')::integer as передано_в_окс,
  count(distinct e.менеджер)::integer as человек,
  string_agg(distinct e.менеджер, ', ' order by e.менеджер) as кто
from rop_events e
left join rop_managers m on m.manager_name = e.менеджер and m.active
left join rop_teams t on t.team = m.team
group by 1
order by 1;

-- ============================================================================
-- Как завести второго РОПа
--
-- 1. Supabase Dashboard → Authentication → Users → Add user, «Auto confirm
--    user» включить.
-- 2. Привязать роль и отдел:
--
--    insert into profiles (id, email, role, rop_team)
--    select u.id, u.email, 'rop', 'krivchikova' from auth.users u
--    where u.email = 'ПОЧТА'
--    on conflict (id) do update
--      set role = 'rop', contractor_id = null, rop_team = 'krivchikova';
--
-- 3. Проверить, что видно ровно своё — под её же почтой:
--
--    begin;
--    select set_config('request.jwt.claims',
--      json_build_object(
--        'sub',  (select id::text from auth.users where email = 'ПОЧТА'),
--        'role', 'authenticated')::text, true);
--    set local role authenticated;
--    select current_rop_team() as свой_отдел,
--           (select count(distinct отдел) from rop_portal_daily) as видит_отделов;
--    rollback;
--
--    Второй столбец обязан быть равен единице.
-- ============================================================================
