-- ============================================================================
-- Договор БФЛ опознаётся по депозиту АУ, а не по слову «банкротство».
--
-- ЧТО БЫЛО НЕ ТАК. Признак «есть БФЛ» ставился, если среди товарных позиций
-- встречалось банкротство, реструктуризация или депозит АУ. Правило собрано
-- из названий услуг, а названия пишет менеджер руками: достаточно назвать
-- позицию иначе, и договор перестаёт быть БФЛ. Обратная ошибка хуже: слово
-- «банкротство» попадает в название консультации или анализа, и в счёт
-- заключённых договоров падает то, что договором не является.
--
-- КАК ПРАВИЛЬНО. Депозит арбитражного управляющего есть у каждого договора
-- БФЛ и только у него. Реструктуризация — тоже банкротство, и депозит у неё
-- тоже есть, поэтому отдельного правила для неё не нужно. Признак по
-- депозиту не зависит от того, как назвали основную услугу.
--
-- ЧТО ИЗ ЭТОГО СЛЕДУЕТ ДЛЯ ЭКРАНА. «Передано в ОКС: все» перестаёт быть
-- главной цифрой отдела — её место занимает «Договоры БФЛ». Показатель
-- окс_всего остаётся в витринах: он нужен для портфеля и приёмки, просто
-- больше не выносится в план-факт.
-- ============================================================================

-- --- 1. Признак БФЛ ---------------------------------------------------------
--
-- Витрина заменяется через CREATE OR REPLACE намеренно: DROP ... CASCADE
-- увёл бы за собой всю цепочку rop_events → rop_daily → rop_portal_*, и
-- пришлось бы перезаливать шесть миграций ради одного выражения. Состав и
-- порядок колонок не меняются, меняется только правило в «есть_бфл».
create or replace view rop_deal_money as
select
  p.deal_id,
  sum(p.total) filter (where rop_product_group(p.product_name) <> 'ФПА') as чек,
  sum(p.total) filter (where rop_product_group(p.product_name) = 'ФПА') as фпа,
  -- ВОТ ЗДЕСЬ ПРАВИЛО. Не группа услуги, а наличие депозита среди позиций.
  bool_or(lower(coalesce(p.product_name, '')) like '%депозит%') as есть_бфл,
  bool_or(rop_product_group(p.product_name) = 'АЗ') as есть_аз,
  bool_or(rop_product_group(p.product_name) = 'ВКИ') as есть_вки,
  bool_or(rop_product_group(p.product_name) = 'ФПА') as есть_фпа,
  count(*)::integer as позиций
from rop_deal_products p
group by p.deal_id;

-- CREATE OR REPLACE может сбросить настройки вьюхи, поэтому права и режим
-- выставляются заново. Витрина обязана остаться definer и недоступной
-- клиентским ролям — почему именно так, разобрано в 20261019_rop_portal_chain.sql.
alter view rop_deal_money set (security_invoker = false);
revoke all on rop_deal_money from anon, authenticated;

-- --- 2. Договоры БФЛ в разрезе менеджеров -----------------------------------
--
-- В витрину по менеджерам окс_бфл не попадал: там хватало суммы чека по БФЛ.
-- Теперь по этой цифре менеджеру ставится план, значит она нужна отдельно.
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
  sum(e.чек) filter (where e.stage_id = 'C34:WON' and e.есть_бфл)::numeric as чек_бфл_сумма,
  count(*) filter (where e.stage_id = 'C34:WON' and e.есть_бфл and e.чек is not null)::integer as чек_бфл_сделок,
  m.sort_order
from rop_events e
join rop_managers m on m.manager_name = e.менеджер and m.team is not null
group by e.дата, m.team, e.менеджер, m.active, e.группа, m.sort_order;

revoke all on rop_daily_manager from anon, authenticated;

drop view if exists rop_portal_manager;
create view rop_portal_manager as
select d.*
from rop_daily_manager d
where rop_can_read()
  and (is_staff() or d.отдел = current_rop_team());

revoke all on rop_portal_manager from anon;
grant select on rop_portal_manager to authenticated;

-- ============================================================================
-- ПРОВЕРКИ. Прогнать после миграции — они отвечают на вопрос, не стало ли
-- правило по депозиту слишком узким или слишком широким.
--
-- 1. Какие вообще позиции содержат слово «депозит». Если в списке окажется
--    что-то, кроме депозита АУ, правило надо сузить до 'депозит ау'.
--
-- select rop_product_group(product_name) as группа, product_name, count(*)
-- from rop_deal_products
-- where lower(coalesce(product_name, '')) like '%депозит%'
-- group by 1, 2 order by 3 desc;
--
-- 2. Старое правило против нового на переданных в ОКС. Строка «было БФЛ,
--    стало нет» — это сделки, где банкротство назвали, а депозит не
--    выставили: их стоит посмотреть глазами.
--
-- select по_названию, по_депозиту, count(*) as сделок
-- from (
--   select d.deal_id,
--     bool_or(rop_product_group(p.product_name) = 'БФЛ') as по_названию,
--     bool_or(lower(coalesce(p.product_name, '')) like '%депозит%') as по_депозиту
--   from rop_deals d
--   join rop_deal_products p on p.deal_id = d.deal_id
--   where d.category_id = 34 and d.stage_id = 'C34:WON'
--   group by d.deal_id
-- ) x
-- group by 1, 2 order by 3 desc;
--
-- 3. Что теперь показывает дашборд за текущий месяц.
--
-- select sum(окс_всего) as всего, sum(окс_бфл) as бфл,
--        sum(окс_аз) as аз, sum(окс_вки) as вки
-- from rop_daily
-- where дата >= date_trunc('month', current_date)::date;
-- ============================================================================
