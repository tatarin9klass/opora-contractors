-- ============================================================================
-- Результаты уволенного принадлежат отделу.
--
-- ЧТО БЫЛО НЕ ТАК. Флаг «активен» выполнял две разные работы сразу: не
-- показывать человека в списках и не считать его результаты вовсе. Первое
-- верно, второе — нет.
--
-- Расстегаев уволен, и из-за этого его 18 встреч и 14 передач в ОКС
-- выпали из отдела Кривчиковой: в сверке охвата он числился «не заведён в
-- составе». Но передачи случились, отдел их сделал, и в план-факте они
-- обязаны быть — иначе месяц, в котором кто-то уволился, задним числом
-- становится хуже, чем был. Четырнадцать передач это больше, чем даёт
-- любой отдельный менеджер за месяц.
--
-- КАК ТЕПЕРЬ. Витрины потока считают всех, кто закреплён за отделом,
-- независимо от того, работает человек сейчас или нет: событие
-- принадлежит отделу, а не трудовому договору. Флаг остаётся там, где
-- речь о сегодняшнем дне: кому ставить планы и чей портфель разбирать.
--
-- В таблице менеджеров ушедший виден с пометкой — если за период у него
-- были результаты, он показан; если не было, строки просто не появится,
-- потому что считать нечего.
-- ============================================================================

-- --- Поток: считаем всех, кто закреплён за отделом ---------------------------
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
join rop_managers m on m.manager_name = e.менеджер and m.team is not null
group by e.дата, m.team, e.группа;

drop view if exists rop_daily_manager cascade;
create view rop_daily_manager as
select
  e.дата,
  m.team as отдел,
  e.менеджер,
  m.active as работает,
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
join rop_managers m on m.manager_name = e.менеджер and m.team is not null
group by e.дата, m.team, e.менеджер, m.active, e.группа, m.sort_order;

revoke all on rop_daily from anon, authenticated;
revoke all on rop_daily_manager from anon, authenticated;

-- --- Портфель: тоже все, но с пометкой ---------------------------------------
-- Открытая сделка на уволенном — не статистика, а задача: её надо кому-то
-- передать. Прятать такие сделки хуже всего: они просто исчезнут из
-- портфеля отдела, и никто о них не вспомнит.
drop view if exists rop_portfolio_deal cascade;
create view rop_portfolio_deal as
select
  d.deal_id,
  d.title,
  m.team as отдел,
  d.assigned_by_name as менеджер,
  m.active as работает,
  d.stage_id,
  d.stage_name as этап,
  rop_stage_kind(d.stage_id) as состояние,
  rop_source_group(d.source_name) as группа,
  d.date_create as создана,
  d.moved_time as последнее_движение,
  (current_date - (coalesce(d.moved_time, d.date_create) at time zone 'Europe/Moscow')::date)
    as дней_без_движения,
  (current_date - (d.date_create at time zone 'Europe/Moscow')::date) as возраст_дней,
  coalesce(lim.порог_дней, 30) as порог_дней,
  (current_date - (coalesce(d.moved_time, d.date_create) at time zone 'Europe/Moscow')::date)
    > coalesce(lim.порог_дней, 30) as залежалась,
  money.чек,
  d.opportunity as сумма_поля,
  money.есть_бфл,
  money.есть_аз,
  money.есть_вки
from rop_deals d
join rop_managers m on m.manager_name = d.assigned_by_name and m.team is not null
left join rop_deal_money money on money.deal_id = d.deal_id
left join rop_stage_limit lim on lim.stage_id = d.stage_id
where coalesce(d.closed, false) = false
  and d.category_id = 34;

revoke all on rop_portfolio_deal from anon, authenticated;

drop view if exists rop_portfolio cascade;
create view rop_portfolio as
select
  p.отдел,
  p.менеджер,
  p.работает,
  p.состояние,
  p.stage_id,
  p.этап,
  count(*)::integer as сделок,
  count(*) filter (where p.залежалась)::integer as залежалось,
  max(p.порог_дней)::integer as порог_дней,
  percentile_cont(0.5) within group (order by p.дней_без_движения)::numeric(6, 1)
    as медиана_простоя,
  sum(p.чек)::numeric as чек_сумма,
  count(p.чек)::integer as чек_сделок,
  count(*) filter (where p.чек is null and coalesce(p.сумма_поля, 0) = 0)::integer as без_суммы,
  max(wr.доля_дошедших) as шанс_дойти,
  round(count(*) * coalesce(max(wr.доля_дошедших), 0) / 100.0, 1) as ожидаемо_окс
from rop_portfolio_deal p
left join rop_stage_win_rate wr on wr.stage_id = p.stage_id
group by p.отдел, p.менеджер, p.работает, p.состояние, p.stage_id, p.этап;

revoke all on rop_portfolio from anon, authenticated;

-- --- Вне состава: теперь это действительно «вне состава» ---------------------
drop view if exists rop_portfolio_outside cascade;
create view rop_portfolio_outside as
select
  coalesce(d.assigned_by_name, '— без ответственного —') as кто,
  count(*)::integer as сделок,
  count(*) filter (where d.stage_id = 'C34:PREPARATION')::integer as на_икп,
  min(d.date_create)::date as самая_старая
from rop_deals d
left join rop_managers m on m.manager_name = d.assigned_by_name and m.team is not null
where coalesce(d.closed, false) = false
  and d.category_id = 34
  and m.manager_name is null
group by 1
order by 2 desc;

revoke all on rop_portfolio_outside from anon, authenticated;

-- --- Сверка охвата -----------------------------------------------------------
-- Ушедшие больше не попадают в «не заведён»: они заведены, просто не
-- работают. Отдельная колонка показывает, сколько результатов периода
-- принадлежит таким людям — это нормальная часть результата отдела, но
-- знать о ней стоит.
drop view if exists rop_scope_check;
create view rop_scope_check with (security_invoker = true) as
select
  coalesce(t.title, 'НЕ ЗАВЕДЁН В СОСТАВЕ') as отдел,
  count(*) filter (where e.stage_id = 'C34:NEW')::integer as встречи,
  count(*) filter (where e.stage_id = 'C34:WON')::integer as передано_в_окс,
  count(*) filter (where e.stage_id = 'C34:WON' and m.active = false)::integer as из_них_у_ушедших,
  count(distinct e.менеджер)::integer as человек,
  string_agg(distinct e.менеджер, ', ' order by e.менеджер) as кто
from rop_events e
left join rop_managers m on m.manager_name = e.менеджер and m.team is not null
left join rop_teams t on t.team = m.team
group by 1
order by 1;

-- ============================================================================
-- Кабинет
-- ============================================================================
drop view if exists rop_portal_daily;
create view rop_portal_daily as
select d.* from rop_daily d
where rop_can_read() and (is_staff() or d.отдел = current_rop_team());
revoke all on rop_portal_daily from anon;
grant select on rop_portal_daily to authenticated;

drop view if exists rop_portal_manager;
create view rop_portal_manager as
select d.* from rop_daily_manager d
where rop_can_read() and (is_staff() or d.отдел = current_rop_team());
revoke all on rop_portal_manager from anon;
grant select on rop_portal_manager to authenticated;

drop view if exists rop_portal_portfolio;
create view rop_portal_portfolio as
select p.* from rop_portfolio p
where rop_can_read() and (is_staff() or p.отдел = current_rop_team());
revoke all on rop_portal_portfolio from anon;
grant select on rop_portal_portfolio to authenticated;

drop view if exists rop_portal_stuck;
create view rop_portal_stuck as
select
  d.отдел, d.менеджер, d.работает, d.deal_id, d.title, d.этап, d.состояние,
  d.дней_без_движения, d.порог_дней, d.возраст_дней, d.чек, d.группа
from rop_portfolio_deal d
where rop_can_read()
  and (is_staff() or d.отдел = current_rop_team())
  and d.залежалась;
revoke all on rop_portal_stuck from anon;
grant select on rop_portal_stuck to authenticated;

drop view if exists rop_portal_outside;
create view rop_portal_outside as
select o.* from rop_portfolio_outside o where is_staff();
revoke all on rop_portal_outside from anon;
grant select on rop_portal_outside to authenticated;

-- Список для планов остаётся только из работающих: ставить план ушедшему
-- незачем.
drop view if exists rop_portal_managers;
create view rop_portal_managers as
select m.manager_name, m.team as отдел, m.sort_order
from rop_managers m
where m.active and m.team is not null and rop_can_read()
  and (is_staff() or m.team = current_rop_team());
revoke all on rop_portal_managers from anon;
grant select on rop_portal_managers to authenticated;

-- ============================================================================
-- Проверка
--
--   select * from rop_scope_check;
--
-- Строки «НЕ ЗАВЕДЁН В СОСТАВЕ» быть не должно вовсе, либо в ней только
-- технические карточки. У отдела Кривчиковой в колонке «из них у ушедших»
-- появятся передачи Расстегаева — это нормально, они принадлежат отделу.
-- ============================================================================
