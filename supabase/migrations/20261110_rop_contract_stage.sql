-- ============================================================================
-- Договор = сделка с датой входа в стадию «Полная / частичная оплата».
--
-- ТРИ ОШИБКИ СРАЗУ, И ВСЕ ТРИ ОТ ОДНОГО РЕШЕНИЯ. Договоры кабинета РОПа
-- считались по стадии «C34:WON» — передаче в делопроизводство — и по
-- истории переходов.
--
-- ПЕРВАЯ: ВКИ ТУДА НЕ ДОХОДИТ. Восстановление кредитной истории продаётся
-- отдельно, банкротного дела за ним нет, передавать в делопроизводство
-- нечего. До «WON» такие сделки не добираются никогда — поэтому плитка ВКИ
-- у Измайлова показывала пусто, хотя ВКИ продавались.
--
-- ВТОРАЯ: ЦИФРЫ НЕ СХОДИЛИСЬ С ДАШБОРДОМ. Дашборд подрядчиков считает
-- оплаченные сделки по полю UF_CRM_1744372636 — дате входа в стадию
-- оплаты. Кабинет РОПа считал по другому событию, и две страницы одного
-- приложения показывали за один месяц разное.
--
-- ТРЕТЬЯ: ПОВТОРНЫЙ ВХОД СЧИТАЛСЯ ДВАЖДЫ. История стадий записывает каждый
-- переход. Сделка, которая вышла со стадии оплаты и вернулась, давала два
-- договора вместо одного. У поля дата одна на сделку, и такого быть не
-- может.
--
-- КАК ТЕПЕРЬ. Договоры берутся из самих сделок по полю paid_at — то же
-- поле, тот же смысл, что у дашборда, разбивка по товарам сверху. Этапы
-- воронки (встречи, брак, ИКП, передача в ОКС) по-прежнему считаются по
-- истории переходов: там событие и есть предмет счёта.
--
-- ТРЕБУЕТ ОБНОВЛЁННОГО ИМПОРТА. Колонка paid_at заполняется функцией
-- rop-deals; пока она не перезалита и не прогнана, договоры будут нулевыми.
-- ============================================================================

alter table rop_deals add column if not exists paid_at timestamptz;
create index if not exists rop_deals_paid_idx on rop_deals(paid_at);

-- --- Поток по отделам -------------------------------------------------------
drop view if exists rop_daily cascade;
create view rop_daily as
with воронка as (
  select
    e.дата, m.team as отдел, e.группа,
    count(*) filter (where e.stage_id = 'C34:NEW')::integer as встречи,
    count(*) filter (where e.stage_id = 'C34:7')::integer as брак,
    count(*) filter (where e.stage_id = 'C34:PREPARATION')::integer as икп,
    count(*) filter (where e.stage_id = 'C34:PREPAYMENT_INVOIC')::integer as договор_без_оплаты,
    -- Передача в делопроизводство осталась в данных: она нужна портфелю и
    -- разбору приёмки. План-факт по ней больше не строится.
    count(*) filter (where e.stage_id = 'C34:WON')::integer as передано_в_окс
  from rop_events e
  join rop_managers m on m.manager_name = e.менеджер and m.team is not null
  group by e.дата, m.team, e.группа
),
договоры as (
  select
    (d.paid_at at time zone 'Europe/Moscow')::date as дата,
    m.team as отдел,
    rop_source_group(d.source_name) as группа,
    count(*)::integer as окс_всего,
    count(*) filter (where mo.есть_бфл)::integer as окс_бфл,
    count(*) filter (where mo.есть_аз)::integer as окс_аз,
    count(*) filter (where mo.есть_вки)::integer as окс_вки,
    count(*) filter (where mo.есть_вбфл)::integer as окс_вбфл,
    count(*) filter (where mo.есть_фпа)::integer as окс_фпа,
    sum(mo.чек)::numeric as чек_сумма,
    count(*) filter (where mo.чек is not null)::integer as чек_сделок,
    sum(mo.фпа)::numeric as фпа_сумма
  from rop_deals d
  join rop_managers m on m.manager_name = d.assigned_by_name and m.team is not null
  left join rop_deal_money mo on mo.deal_id = d.deal_id
  where d.paid_at is not null and d.category_id = 34
  group by 1, 2, 3
)
select
  coalesce(v.дата, g.дата) as дата,
  coalesce(v.отдел, g.отдел) as отдел,
  coalesce(v.группа, g.группа) as группа,
  coalesce(v.встречи, 0) as встречи,
  coalesce(v.брак, 0) as брак,
  coalesce(v.икп, 0) as икп,
  coalesce(v.договор_без_оплаты, 0) as договор_без_оплаты,
  coalesce(v.передано_в_окс, 0) as передано_в_окс,
  coalesce(g.окс_всего, 0) as окс_всего,
  coalesce(g.окс_бфл, 0) as окс_бфл,
  coalesce(g.окс_аз, 0) as окс_аз,
  coalesce(g.окс_вки, 0) as окс_вки,
  coalesce(g.окс_вбфл, 0) as окс_вбфл,
  coalesce(g.окс_фпа, 0) as окс_фпа,
  g.чек_сумма,
  coalesce(g.чек_сделок, 0) as чек_сделок,
  g.фпа_сумма
from воронка v
full outer join договоры g
  on g.дата = v.дата and g.отдел = v.отдел and g.группа = v.группа;

-- --- Поток по менеджерам ----------------------------------------------------
drop view if exists rop_daily_manager cascade;
create view rop_daily_manager as
with воронка as (
  select
    e.дата, m.team as отдел, e.менеджер, m.active as работает, e.группа, m.sort_order,
    count(*) filter (where e.stage_id = 'C34:NEW')::integer as встречи,
    count(*) filter (where e.stage_id = 'C34:7')::integer as брак,
    count(*) filter (where e.stage_id = 'C34:PREPARATION')::integer as икп,
    count(*) filter (where e.stage_id = 'C34:PREPAYMENT_INVOIC')::integer as договор_без_оплаты,
    count(*) filter (where e.stage_id = 'C34:WON')::integer as передано_в_окс
  from rop_events e
  join rop_managers m on m.manager_name = e.менеджер and m.team is not null
  group by e.дата, m.team, e.менеджер, m.active, e.группа, m.sort_order
),
договоры as (
  select
    (d.paid_at at time zone 'Europe/Moscow')::date as дата,
    m.team as отдел, d.assigned_by_name as менеджер, m.active as работает,
    rop_source_group(d.source_name) as группа, m.sort_order,
    count(*)::integer as окс_всего,
    count(*) filter (where mo.есть_бфл)::integer as окс_бфл,
    count(*) filter (where mo.есть_аз)::integer as окс_аз,
    count(*) filter (where mo.есть_вки)::integer as окс_вки,
    count(*) filter (where mo.есть_вбфл)::integer as окс_вбфл,
    count(*) filter (where mo.есть_фпа)::integer as окс_фпа,
    sum(mo.чек) filter (where mo.есть_бфл)::numeric as чек_бфл_сумма,
    count(*) filter (where mo.есть_бфл and mo.чек is not null)::integer as чек_бфл_сделок
  from rop_deals d
  join rop_managers m on m.manager_name = d.assigned_by_name and m.team is not null
  left join rop_deal_money mo on mo.deal_id = d.deal_id
  where d.paid_at is not null and d.category_id = 34
  group by 1, 2, 3, 4, 5, 6
)
select
  coalesce(v.дата, g.дата) as дата,
  coalesce(v.отдел, g.отдел) as отдел,
  coalesce(v.менеджер, g.менеджер) as менеджер,
  coalesce(v.работает, g.работает) as работает,
  coalesce(v.группа, g.группа) as группа,
  coalesce(v.встречи, 0) as встречи,
  coalesce(v.брак, 0) as брак,
  coalesce(v.икп, 0) as икп,
  coalesce(v.договор_без_оплаты, 0) as договор_без_оплаты,
  coalesce(v.передано_в_окс, 0) as передано_в_окс,
  coalesce(g.окс_всего, 0) as окс_всего,
  coalesce(g.окс_бфл, 0) as окс_бфл,
  coalesce(g.окс_аз, 0) as окс_аз,
  coalesce(g.окс_вки, 0) as окс_вки,
  coalesce(g.окс_вбфл, 0) as окс_вбфл,
  coalesce(g.окс_фпа, 0) as окс_фпа,
  g.чек_бфл_сумма,
  coalesce(g.чек_бфл_сделок, 0) as чек_бфл_сделок,
  coalesce(v.sort_order, g.sort_order) as sort_order
from воронка v
full outer join договоры g
  on g.дата = v.дата and g.отдел = v.отдел and g.менеджер = v.менеджер
 and g.группа = v.группа;

revoke all on rop_daily from anon, authenticated;
revoke all on rop_daily_manager from anon, authenticated;

-- --- Обёртки кабинета -------------------------------------------------------
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

-- ============================================================================
-- ПРОВЕРКИ. Прогонять ПОСЛЕ перезаливки функции rop-deals и импорта.
--
-- 1. Заполнилось ли поле вообще. Если «с датой оплаты» ноль — импорт не
--    обновлён, и договоры будут пустыми.
--
-- select count(*) as сделок, count(paid_at) as с_датой_оплаты from rop_deals;
--
-- 2. Сходится ли с дашбордом за текущий месяц. Левое считает кабинет РОПа,
--    правое — то же поле напрямую; числа обязаны совпасть.
--
-- select
--   (select sum(окс_всего) from rop_daily
--     where дата >= date_trunc('month', current_date)::date) as в_кабинете,
--   (select count(*) from rop_deals
--     where category_id = 34
--       and (paid_at at time zone 'Europe/Moscow')::date >= date_trunc('month', current_date)::date
--   ) as в_сделках;
--
-- 3. Что изменилось по продуктам. ВКИ должен перестать быть нулём.
--
-- select sum(окс_бфл) as бфл, sum(окс_вбфл) as вбфл, sum(окс_аз) as аз,
--        sum(окс_вки) as вки, sum(окс_фпа) as фпа, sum(окс_всего) as всего,
--        sum(передано_в_окс) as передано
-- from rop_daily where дата >= date_trunc('month', current_date)::date;
--
-- 4. Сколько сделок дошло до оплаты, но не имеет ни одной товарной
--    позиции: такие попадут в «всего», но ни в один продукт.
--
-- select count(*) as без_позиций
-- from rop_deals d left join rop_deal_money mo on mo.deal_id = d.deal_id
-- where d.paid_at is not null and d.category_id = 34 and mo.deal_id is null;
-- ============================================================================
