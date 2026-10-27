-- ============================================================================
-- Внесудебное банкротство и ФПА становятся отдельными показателями.
--
-- ЧТО БЫЛО НЕ ТАК. «Банкротство через МФЦ» содержит слово «банкротство» и
-- потому попадало в группу БФЛ. Пока БФЛ опознавался по названию услуги,
-- внесудебное молча подмешивалось к судебному — разным продуктам с разной
-- ценой и разным процессом. После перехода на депозит АУ стало хуже:
-- депозита у внесудебного нет, поэтому оно перестало считаться вообще и
-- выпало из отчётности целиком.
--
-- ФПА считался только суммой. Это анализ, который продают до банкротства,
-- чтобы понять, подходит ли клиент; в чек он намеренно не входит. Но знать,
-- сколько их продано штуками, нужно — это вход в воронку.
--
-- ПОРЯДОК ВЕТОК В rop_product_group ЗНАЧИМ. Внесудебное проверяется ДО
-- обычного банкротства: иначе первая же ветка со словом «банкротств»
-- перехватит его обратно в БФЛ.
-- ============================================================================

create or replace function rop_product_group(product_name text)
returns text language sql immutable as $$
  select case
    when lower(coalesce(product_name, '')) like '%финансово-правов%' then 'ФПА'
    when lower(coalesce(product_name, '')) like '%адвокатск%'        then 'АЗ'
    when lower(coalesce(product_name, '')) like '%вки%'
      or lower(coalesce(product_name, '')) like '%кредитной истории%' then 'ВКИ'
    -- ВОТ ЭТА ВЕТКА ДОЛЖНА СТОЯТЬ ВЫШЕ СЛЕДУЮЩЕЙ.
    when lower(coalesce(product_name, '')) like '%мфц%'
      or lower(coalesce(product_name, '')) like '%внесудеб%'          then 'ВБФЛ'
    when lower(coalesce(product_name, '')) like '%банкротств%'
      or lower(coalesce(product_name, '')) like '%реструктуризац%'
      or lower(coalesce(product_name, '')) like '%депозит ау%'        then 'БФЛ'
    else 'прочее'
  end;
$$;

-- --- Признак внесудебного в деньгах сделки ----------------------------------
--
-- Витрины заменяются через CREATE OR REPLACE намеренно: DROP ... CASCADE
-- увёл бы за собой всю цепочку и потребовал бы перезалить шесть миграций.
-- Состав и порядок прежних колонок не меняются, новые дописаны в конец.
create or replace view rop_deal_money as
select
  p.deal_id,
  sum(p.total) filter (where rop_product_group(p.product_name) <> 'ФПА') as чек,
  sum(p.total) filter (where rop_product_group(p.product_name) = 'ФПА') as фпа,
  -- БФЛ — по депозиту АУ, а не по названию услуги. См. 20261027.
  bool_or(lower(coalesce(p.product_name, '')) like '%депозит%') as есть_бфл,
  bool_or(rop_product_group(p.product_name) = 'АЗ') as есть_аз,
  bool_or(rop_product_group(p.product_name) = 'ВКИ') as есть_вки,
  bool_or(rop_product_group(p.product_name) = 'ФПА') as есть_фпа,
  count(*)::integer as позиций,
  bool_or(rop_product_group(p.product_name) = 'ВБФЛ') as есть_вбфл
from rop_deal_products p
group by p.deal_id;

alter view rop_deal_money set (security_invoker = false);
revoke all on rop_deal_money from anon, authenticated;

-- --- Признаки доезжают до событий -------------------------------------------
create or replace view rop_events as
select
  s.deal_id,
  s.stage_id,
  s.stage_name,
  (s.entered_at at time zone 'Europe/Moscow')::date as дата,
  d.assigned_by_name as менеджер,
  d.source_name,
  rop_source_group(d.source_name) as группа,
  m.чек,
  m.фпа,
  coalesce(m.есть_бфл, false) as есть_бфл,
  coalesce(m.есть_аз, false) as есть_аз,
  coalesce(m.есть_вки, false) as есть_вки,
  coalesce(m.есть_вбфл, false) as есть_вбфл,
  coalesce(m.есть_фпа, false) as есть_фпа
from rop_deal_stages s
join rop_deals d on d.deal_id = s.deal_id
left join rop_deal_money m on m.deal_id = s.deal_id
where s.stage_id like 'C34:%';

alter view rop_events set (security_invoker = false);
revoke all on rop_events from anon, authenticated;

-- --- Счётчики в витринах потока ---------------------------------------------
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
  count(*) filter (where e.stage_id = 'C34:WON' and e.есть_бфл)::integer as окс_бфл,
  count(*) filter (where e.stage_id = 'C34:WON' and e.есть_аз)::integer as окс_аз,
  count(*) filter (where e.stage_id = 'C34:WON' and e.есть_вки)::integer as окс_вки,
  count(*) filter (where e.stage_id = 'C34:WON' and e.есть_вбфл)::integer as окс_вбфл,
  count(*) filter (where e.stage_id = 'C34:WON' and e.есть_фпа)::integer as окс_фпа,
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
  count(*) filter (where e.stage_id = 'C34:WON' and e.есть_бфл)::integer as окс_бфл,
  count(*) filter (where e.stage_id = 'C34:WON' and e.есть_аз)::integer as окс_аз,
  count(*) filter (where e.stage_id = 'C34:WON' and e.есть_вки)::integer as окс_вки,
  count(*) filter (where e.stage_id = 'C34:WON' and e.есть_вбфл)::integer as окс_вбфл,
  count(*) filter (where e.stage_id = 'C34:WON' and e.есть_фпа)::integer as окс_фпа,
  sum(e.чек) filter (where e.stage_id = 'C34:WON' and e.есть_бфл)::numeric as чек_бфл_сумма,
  count(*) filter (where e.stage_id = 'C34:WON' and e.есть_бфл and e.чек is not null)::integer as чек_бфл_сделок,
  m.sort_order
from rop_events e
join rop_managers m on m.manager_name = e.менеджер and m.team is not null
group by e.дата, m.team, e.менеджер, m.active, e.группа, m.sort_order;

revoke all on rop_daily from anon, authenticated;
revoke all on rop_daily_manager from anon, authenticated;

-- --- Обёртки кабинета -------------------------------------------------------
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

-- ============================================================================
-- ПРОВЕРКИ. Правила опознания продуктов собраны из названий позиций, а
-- названия пишет менеджер руками. Прогнать после миграции.
--
-- 1. Как разложились все позиции по группам. Строка «прочее» с заметным
--    количеством означает, что продукт есть, а правила под него нет.
--
-- select rop_product_group(product_name) as группа, product_name, count(*)
-- from rop_deal_products
-- group by 1, 2 order by 1, 3 desc;
--
-- 2. Что попало во внесудебное. Здесь должно быть только банкротство через
--    МФЦ; если правило по «мфц» ловит лишнее, его надо сузить.
--
-- select product_name, count(*)
-- from rop_deal_products
-- where rop_product_group(product_name) = 'ВБФЛ'
-- group by 1 order by 2 desc;
--
-- 3. Что показывает «Главное» за текущий месяц.
--
-- select sum(окс_бфл) as бфл, sum(окс_аз) as аз, sum(окс_вки) as вки,
--        sum(окс_вбфл) as вбфл, sum(окс_фпа) as фпа, sum(окс_всего) as всего
-- from rop_daily
-- where дата >= date_trunc('month', current_date)::date;
-- ============================================================================
