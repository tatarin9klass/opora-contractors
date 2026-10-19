-- ============================================================================
-- Кабинет РОПа: витрины.
--
-- ГЛАВНОЕ РЕШЕНИЕ — ВСЁ СЧИТАЕТСЯ ПО ДАТЕ СОБЫТИЯ, А НЕ ПО ТЕКУЩЕЙ СТАДИИ.
-- Встреча относится к дню, когда сделка попала на «Встреча проведена»,
-- передача в ОКС — ко дню перехода в «Передано в Делопроизводство», брак —
-- ко дню, когда её туда отправили. Ровно та же логика, по которой считается
-- управленческий учёт направления: квал в день квала, встреча в день
-- встречи.
--
-- Из этого следует то, ради чего затевалась история стадий: сделка попадает
-- в ЧИСЛИТЕЛЬ КАЖДОГО этапа, через который прошла. Если считать по текущей
-- стадии, дошедшая до оплаты исчезнет из «ИКП сформирован», и конверсия
-- покажет не работу отдела, а количество застрявших.
--
-- ВТОРОЕ РЕШЕНИЕ: ЧЕК СОБИРАЕТСЯ ИЗ ПОЗИЦИЙ, А НЕ ИЗ СУММЫ СДЕЛКИ.
-- ФПА по прямому указанию руководителя не входит никуда — ни в чек, ни в
-- показатели ОКС. Он продаётся отдельно и до банкротства, его задача —
-- проверить, подходит ли клиент. Поле OPPORTUNITY его включает, поэтому
-- пользоваться им нельзя.
-- ============================================================================

-- ============================================================================
-- Деньги и состав услуг по сделке
--
-- Позиции есть не у всех: они появляются при формировании ИКП. На выгрузке
-- за сентябрь — у 247 сделок из 569. Это не потеря данных, а отражение того,
-- что до оформления доходит меньшая часть, и средний чек считается по ним.
-- ============================================================================
drop view if exists rop_deal_money cascade;
-- ВАЖНО, ЕСЛИ ПЕРЕСОЗДАЁШЬ ЭТУ ВИТРИНУ. Она намеренно работает с правами
-- владельца и отобрана у клиентских ролей: кабинет РОПа читает её через
-- обёртки rop_portal_*, а роли rop на базовых таблицах доступа нет. Вернёшь
-- security_invoker — кабинет снова покажет нули. Разбор в миграции
-- 20261019_rop_portal_chain.sql.
create view rop_deal_money as
select
  p.deal_id,
  sum(p.total) filter (where rop_product_group(p.product_name) <> 'ФПА') as чек,
  sum(p.total) filter (where rop_product_group(p.product_name) = 'ФПА') as фпа,
  bool_or(rop_product_group(p.product_name) = 'БФЛ') as есть_бфл,
  bool_or(rop_product_group(p.product_name) = 'АЗ') as есть_аз,
  bool_or(rop_product_group(p.product_name) = 'ВКИ') as есть_вки,
  bool_or(rop_product_group(p.product_name) = 'ФПА') as есть_фпа,
  count(*)::integer as позиций
from rop_deal_products p
group by p.deal_id;

-- ============================================================================
-- События воронки: одна строка — один переход сделки на этап
--
-- Здесь же приклеены менеджер, группа источника и деньги, чтобы витринам
-- выше не пришлось джойнить это заново и чтобы разрез «маркетинг против
-- рекомендаций» работал на любом показателе одинаково.
-- ============================================================================
drop view if exists rop_events cascade;
-- ВАЖНО, ЕСЛИ ПЕРЕСОЗДАЁШЬ ЭТУ ВИТРИНУ. Она намеренно работает с правами
-- владельца и отобрана у клиентских ролей: кабинет РОПа читает её через
-- обёртки rop_portal_*, а роли rop на базовых таблицах доступа нет. Вернёшь
-- security_invoker — кабинет снова покажет нули. Разбор в миграции
-- 20261019_rop_portal_chain.sql.
create view rop_events as
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
  coalesce(m.есть_вки, false) as есть_вки
from rop_deal_stages s
join rop_deals d on d.deal_id = s.deal_id
left join rop_deal_money m on m.deal_id = s.deal_id
-- Стадии чужих воронок в истории встречаются: сделки переезжают между
-- направлениями. Для показателей отдела продаж они шум.
where s.stage_id like 'C34:%';

-- ============================================================================
-- Когда появился каждый этап
--
-- Часть этапов заведена недавно: «Полная/частичная оплата» впервые
-- встречается 3 октября, «Передача в ОИ» — 6 октября. За более ранний период
-- по ним не ноль, а «показателя не существовало», и путать это нельзя:
-- РОП прочитает ноль как провал отдела.
-- ============================================================================
drop view if exists rop_stage_since;
-- ВАЖНО, ЕСЛИ ПЕРЕСОЗДАЁШЬ ЭТУ ВИТРИНУ. Она намеренно работает с правами
-- владельца и отобрана у клиентских ролей: кабинет РОПа читает её через
-- обёртки rop_portal_*, а роли rop на базовых таблицах доступа нет. Вернёшь
-- security_invoker — кабинет снова покажет нули. Разбор в миграции
-- 20261019_rop_portal_chain.sql.
create view rop_stage_since as
select
  stage_id,
  max(stage_name) as стадия,
  min((entered_at at time zone 'Europe/Moscow')::date) as этап_с,
  count(distinct deal_id)::integer as сделок
from rop_deal_stages
where stage_id like 'C34:%'
group by stage_id;

-- ============================================================================
-- Дневная витрина отдела
--
-- По дню и группе источника. Период любой длины собирается суммированием,
-- поэтому неделя, месяц и произвольный диапазон считаются одинаково.
--
-- ПОЧЕМУ СРЕДНИЙ ЧЕК ОТДАЁТСЯ СУММОЙ И ШТУКАМИ, А НЕ ГОТОВЫМ ЧИСЛОМ: среднее
-- нельзя усреднять. Сложив средние за тридцать дней и поделив на тридцать,
-- получим не средний чек месяца, а среднее средних — цифру, которая тем
-- дальше от правды, чем неравномернее дни.
-- ============================================================================
drop view if exists rop_daily;
-- ВАЖНО, ЕСЛИ ПЕРЕСОЗДАЁШЬ ЭТУ ВИТРИНУ. Она намеренно работает с правами
-- владельца и отобрана у клиентских ролей: кабинет РОПа читает её через
-- обёртки rop_portal_*, а роли rop на базовых таблицах доступа нет. Вернёшь
-- security_invoker — кабинет снова покажет нули. Разбор в миграции
-- 20261019_rop_portal_chain.sql.
create view rop_daily as
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
  -- Для среднего чека: сумма и количество отдельно.
  sum(e.чек) filter (where e.stage_id = 'C34:WON')::numeric as чек_сумма,
  count(*) filter (where e.stage_id = 'C34:WON' and e.чек is not null)::integer as чек_сделок,
  sum(e.фпа) filter (where e.stage_id = 'C34:WON')::numeric as фпа_сумма
from rop_events e
group by e.дата, e.группа;

-- ============================================================================
-- Дневная витрина по менеджерам
-- ============================================================================
drop view if exists rop_daily_manager;
-- ВАЖНО, ЕСЛИ ПЕРЕСОЗДАЁШЬ ЭТУ ВИТРИНУ. Она намеренно работает с правами
-- владельца и отобрана у клиентских ролей: кабинет РОПа читает её через
-- обёртки rop_portal_*, а роли rop на базовых таблицах доступа нет. Вернёшь
-- security_invoker — кабинет снова покажет нули. Разбор в миграции
-- 20261019_rop_portal_chain.sql.
create view rop_daily_manager as
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
  -- «Средний чек где есть БФЛ» — только сделки с продуктом банкротства:
  -- разовая юруслуга за 70 тысяч в одном ряду с банкротством за 300 даёт
  -- среднее, которое не описывает ни ту ни другую работу.
  sum(e.чек) filter (where e.stage_id = 'C34:WON' and e.есть_бфл)::numeric as чек_бфл_сумма,
  count(*) filter (where e.stage_id = 'C34:WON' and e.есть_бфл and e.чек is not null)::integer as чек_бфл_сделок
from rop_events e
where e.менеджер is not null
group by e.дата, e.менеджер, e.группа;

-- ============================================================================
-- Справочник менеджеров отдела
--
-- В воронке девять человек, а отдел — трое: Черных, Лисечко, Варламова.
-- Остальные шесть попадают в воронку по другим поводам, и мешать их в один
-- список с отделом нельзя: конверсии разъедутся, а РОП будет спрашивать,
-- кто эти люди.
--
-- Таблица, а не константа в коде: состав отдела меняется чаще, чем выходят
-- миграции.
-- ============================================================================
create table if not exists rop_managers (
  manager_name text primary key,
  active boolean not null default true,
  sort_order integer not null default 100
);

insert into rop_managers (manager_name, sort_order) values
  ('Черных Елена', 10),
  ('Лисечко Дмитрий', 20),
  ('Варламова Светлана', 30)
on conflict (manager_name) do nothing;

alter table rop_managers enable row level security;
drop policy if exists "staff_select" on rop_managers;
create policy "staff_select" on rop_managers for select using (is_staff());
drop policy if exists "admin_write" on rop_managers;
create policy "admin_write" on rop_managers for all using (is_admin()) with check (is_admin());

comment on table rop_managers is
  'Состав отдела продаж. Фамилии должны совпадать с rop_deals.assigned_by_name '
  'как их отдаёт Битрикс — сверяться запросом rop_managers_check.';

-- Кто есть в сделках, но не заведён в отделе, и наоборот. Если фамилия
-- написана иначе, чем в Битриксе, менеджер молча исчезнет из отчёта —
-- проверка нужна именно для этого.
drop view if exists rop_managers_check;
create view rop_managers_check with (security_invoker = true) as
select
  coalesce(d.assigned_by_name, m.manager_name) as фамилия,
  (m.manager_name is not null) as заведён_в_отделе,
  count(d.deal_id)::integer as сделок
from rop_deals d
full join rop_managers m on m.manager_name = d.assigned_by_name
group by 1, 2
order by сделок desc;

-- ============================================================================
-- Внутренние витрины — прочь от клиентов
--
-- Они работают с правами владельца (см. комментарии выше), поэтому выдать их
-- роли authenticated значило бы отдать показатели отдела любому
-- залогиненному, включая подрядчиков. Читать их должны только обёртки
-- rop_portal_*, а те спрашивают rop_can_read().
-- ============================================================================
do $$
declare v text;
begin
  foreach v in array array['rop_deal_money', 'rop_events', 'rop_stage_since', 'rop_daily', 'rop_daily_manager'] loop
    if to_regclass('public.' || v) is not null then
      execute format('revoke all on %I from anon, authenticated', v);
    end if;
  end loop;
end $$;
