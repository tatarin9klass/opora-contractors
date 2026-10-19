-- ============================================================================
-- Витрины отдела считают только свой отдел.
--
-- ЧТО БЫЛО НЕ ТАК. rop_daily и rop_daily_manager считали всех, у кого есть
-- сделки в воронке 34, — девять человек. Но воронка общая: в ней работают
-- и менеджеры другого руководителя (Лаврик, Панова, Тунякина), и уволенный
-- сотрудник, и второй РОП. Их сделок больше, чем у самого отдела: 487
-- встреч против 228.
--
-- То есть РОП открыл бы свой дашборд и увидел результат всей компании,
-- принял его за свой и строил бы по нему планы. Ошибка тем опаснее, что
-- цифры выглядят правдоподобно — просто вдвое больше, чем на самом деле.
--
-- Теперь обе витрины считают только тех, кто заведён в rop_managers и
-- помечен активным. Состав отдела меняется — это таблица, не константа.
--
-- ИЗМАЙЛОВ ВКЛЮЧЁН в состав. Он руководитель, но в прошлом месяце работал
-- как менеджер, и за ним висят 28 сделок. Это результат отдела, и
-- выбрасывать его значило бы занижать факт против плана.
-- ============================================================================

insert into rop_managers (manager_name, sort_order) values
  ('Измайлов Руслан', 5)
on conflict (manager_name) do nothing;

comment on column rop_managers.active is
  'Снять отметку, когда человек ушёл из отдела: его прошлые сделки '
  'останутся в истории, но в текущих показателях он больше не появится.';

-- ============================================================================
-- Дневная витрина отдела — только свои
-- ============================================================================
drop view if exists rop_daily;
create view rop_daily with (security_invoker = true) as
select
  e.дата,
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
join rop_managers m on m.manager_name = e.менеджер and m.active
group by e.дата, e.группа;

-- ============================================================================
-- Дневная витрина по менеджерам — тоже только свои
-- ============================================================================
drop view if exists rop_daily_manager;
create view rop_daily_manager with (security_invoker = true) as
select
  e.дата,
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
join rop_managers m on m.manager_name = e.менеджер and m.active
group by e.дата, e.менеджер, e.группа, m.sort_order;

-- ============================================================================
-- Проверка охвата
--
-- Сколько событий воронки относится к отделу, а сколько к остальным. Если
-- однажды окажется, что отдел считает треть компании, причина будет видна
-- сразу — кто-то не заведён в rop_managers или фамилия написана иначе.
-- ============================================================================
drop view if exists rop_scope_check;
create view rop_scope_check with (security_invoker = true) as
select
  case when m.manager_name is not null then 'отдел' else 'чужие' end as чьё,
  count(*) filter (where e.stage_id = 'C34:NEW')::integer as встречи,
  count(*) filter (where e.stage_id = 'C34:WON')::integer as передано_в_окс,
  count(distinct e.менеджер)::integer as человек
from rop_events e
left join rop_managers m on m.manager_name = e.менеджер and m.active
group by 1;
