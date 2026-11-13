-- ============================================================================
-- Один договор — одна строка, даже если карточек в Битриксе две.
--
-- ЧТО ПРОИСХОДИТ В БИТРИКСЕ. Когда отдел продаж заканчивает работу, рядом
-- с рабочей карточкой создаётся её закрытая копия. Обе остаются в воронке
-- 34, у обеих одна дата оплаты, один клиент и один продукт. Мы считали их
-- за два договора: за ноябрь из 61 строки настоящих договоров оказалось 40,
-- то есть завышение на 21.
--
-- КАК ОТЛИЧИТЬ КОПИЮ. По данным, а не по приписке «(Копия)» в названии: её
-- ставят не всегда, это подтвердили коллеги. Надёжный признак — КОПИЯ
-- ТЕРЯЕТ СВЯЗЬ С ЛИДОМ. На ноябрьской выборке у всех 37 закрытых копий
-- lead_id пустой, у всех рабочих карточек он заполнен.
--
-- ПОЧЕМУ СКЛЕИВАЕМ ПО ИМЕНИ И ДАТЕ, А НЕ ПО ЛИДУ. Как раз потому, что у
-- копии лида нет — соединить пару по нему невозможно. Общее у них другое:
-- клиент и день оплаты. Один человек не подписывает два договора в один
-- день; если такие строки есть, это одна продажа.
--
-- ИМЯ НОРМАЛИЗУЕТСЯ ЖЁСТКО. В живых данных один и тот же человек записан
-- как «❌ Голубенко Денис Владимирович» и «Голубенко Денис Владимирович»,
-- у других двойные пробелы и скобки. Поэтому всё, кроме букв, схлопывается
-- в один пробел. Если имя пустое, ключом становится сам номер сделки —
-- такие строки лучше не склеить вовсе, чем склеить ошибочно.
--
-- ОСТАВЛЯЕМ КАРТОЧКУ С ЛИДОМ. У неё есть источник, а значит работает
-- разрез на маркетинг и рекомендации. У копии источник пришлось бы брать
-- из поля сделки, и часть продаж уехала бы в «прочее».
--
-- ПРОДУКТ ЧИТАЕТСЯ ИЗ НАЗВАНИЯ, НО ТОЛЬКО ДЛЯ БАНКРОТСТВ. Название
-- устроено как «ФИО | Продукт», и банкротство там названо честно:
-- «Банкротство (БФЛ)», «Упрощённое банкротство (БФЛ)»,
-- «Реструктуризация (БФЛ)».
--
-- А ВОТ «РАЗОВАЯ ЮР УСЛУГА» В НАЗВАНИИ — ЭТО ОБЁРТКА, А НЕ ПРОДУКТ.
-- Проверка двух ноябрьских таких сделок показала: 207024 — это ВКИ на
-- 60 000, 207822 — ФПА на 12 500. То есть настоящий продукт лежит в
-- позициях, и плитки ВКИ и ФПА эти сделки уже считают. Отдельная плитка
-- «Разовые» показывала бы их второй раз, поэтому её нет.
--
-- АЗ, ВКИ И ФПА В НАЗВАНИИ ОТСУТСТВУЮТ ВООБЩЕ. Они живут только в
-- товарных позициях — и как допродажа к банкротству, и как отдельный
-- договор. Поэтому считаются по позициям, а не по названию.
--
-- «НЕ ОПОЗНАНО» — ЭТО ЛОВУШКА ДЛЯ НОВОГО ПРОДУКТА. Договор, который не
-- банкротство и в позициях которого нет ни АЗ, ни ВКИ, ни ФПА, не попал
-- бы ни в одну плитку и тихо жил бы только в итоге — то есть выглядел бы
-- как расхождение, с которого весь этот разбор и начался. Появится
-- возврат страховок или другая новая услуга — она окажется здесь, и это
-- сигнал завести ей плитку.
-- ============================================================================

-- --- Продукт по названию сделки ---------------------------------------------
create or replace function rop_title_product(title text)
returns text language sql immutable as $$
  select case
    -- Упрощённое проверяется ДО обычного: в его названии тоже есть слово
    -- «банкротство», и без этого порядка оно уходило бы в БФЛ.
    when lower(coalesce(title, '')) like '%упрощённ%банкротств%'
      or lower(coalesce(title, '')) like '%упрощенн%банкротств%' then 'ВБФЛ'
    when lower(coalesce(title, '')) like '%реструктуризац%'       then 'БФЛ'
    when lower(coalesce(title, '')) like '%банкротств%'           then 'БФЛ'
    -- Всё остальное — «Разовая юр услуга», «Юр. услуги» и любое будущее
    -- название — продуктом из заголовка не считается: что продано на
    -- самом деле, знают только товарные позиции.
    else 'прочее'
  end;
$$;

comment on function rop_title_product(text) is
  'Банкротство из названия сделки «ФИО | Продукт»: БФЛ, ВБФЛ или прочее. '
  'Упрощённое проверяется раньше обычного: слово «банкротство» есть в '
  'обоих. Всё, что не банкротство, разбирается по товарным позициям.';

-- --- Ключ склейки: кто и когда ----------------------------------------------
create or replace function rop_client_key(title text)
returns text language sql immutable as $$
  select nullif(
    trim(regexp_replace(
      regexp_replace(lower(split_part(coalesce(title, ''), '|', 1)), '[^a-zа-яё]+', ' ', 'g'),
      '\s+', ' ', 'g')),
    '');
$$;

comment on function rop_client_key(text) is
  'Имя клиента из названия, очищенное до букв: «❌ Голубенко  Денис» и '
  '«Голубенко Денис» дают одно и то же.';

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
    count(*) filter (where e.stage_id = 'C34:WON')::integer as передано_в_окс
  from rop_events e
  join rop_managers m on m.manager_name = e.менеджер and m.team is not null
  group by e.дата, m.team, e.группа
),
все_карточки as (
  select
    d.deal_id, d.lead_id, d.title, d.assigned_by_name, d.source_name,
    (d.paid_at at time zone 'Europe/Moscow')::date as дата,
    coalesce(rop_client_key(d.title), 'сделка ' || d.deal_id) as клиент
  from rop_deals d
  where d.paid_at is not null and d.category_id = 34
),
договоры_строки as (
  -- Из пары «рабочая карточка + закрытая копия» остаётся та, у которой
  -- есть лид: только по нему известен источник.
  select distinct on (клиент, дата) *
  from все_карточки
  order by клиент, дата, (lead_id is null), deal_id
),
договоры as (
  select
    c.дата,
    m.team as отдел,
    rop_source_group(c.source_name) as группа,
    count(*)::integer as окс_всего,
    count(*) filter (where rop_title_product(c.title) = 'БФЛ')::integer as окс_бфл,
    count(*) filter (where rop_title_product(c.title) = 'ВБФЛ')::integer as окс_вбфл,
    -- Ловушка для нового продукта: не банкротство и ни одной известной
    -- услуги в позициях.
    count(*) filter (
      where rop_title_product(c.title) = 'прочее'
        and not coalesce(mo.есть_аз or mo.есть_вки or mo.есть_фпа, false)
    )::integer as окс_неопознано,
    -- Допродажи в названии не отражены и берутся из товарных позиций.
    count(*) filter (where mo.есть_аз)::integer as окс_аз,
    count(*) filter (where mo.есть_вки)::integer as окс_вки,
    count(*) filter (where mo.есть_фпа)::integer as окс_фпа,
    sum(mo.чек)::numeric as чек_сумма,
    count(*) filter (where mo.чек is not null)::integer as чек_сделок,
    sum(mo.фпа)::numeric as фпа_сумма
  from договоры_строки c
  join rop_managers m on m.manager_name = c.assigned_by_name and m.team is not null
  left join rop_deal_money mo on mo.deal_id = c.deal_id
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
  coalesce(g.окс_вбфл, 0) as окс_вбфл,
  coalesce(g.окс_неопознано, 0) as окс_неопознано,
  coalesce(g.окс_аз, 0) as окс_аз,
  coalesce(g.окс_вки, 0) as окс_вки,
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
все_карточки as (
  select
    d.deal_id, d.lead_id, d.title, d.assigned_by_name, d.source_name,
    (d.paid_at at time zone 'Europe/Moscow')::date as дата,
    coalesce(rop_client_key(d.title), 'сделка ' || d.deal_id) as клиент
  from rop_deals d
  where d.paid_at is not null and d.category_id = 34
),
договоры_строки as (
  select distinct on (клиент, дата) *
  from все_карточки
  order by клиент, дата, (lead_id is null), deal_id
),
договоры as (
  select
    c.дата, m.team as отдел, c.assigned_by_name as менеджер, m.active as работает,
    rop_source_group(c.source_name) as группа, m.sort_order,
    count(*)::integer as окс_всего,
    count(*) filter (where rop_title_product(c.title) = 'БФЛ')::integer as окс_бфл,
    count(*) filter (where rop_title_product(c.title) = 'ВБФЛ')::integer as окс_вбфл,
    count(*) filter (
      where rop_title_product(c.title) = 'прочее'
        and not coalesce(mo.есть_аз or mo.есть_вки or mo.есть_фпа, false)
    )::integer as окс_неопознано,
    count(*) filter (where mo.есть_аз)::integer as окс_аз,
    count(*) filter (where mo.есть_вки)::integer as окс_вки,
    count(*) filter (where mo.есть_фпа)::integer as окс_фпа,
    sum(mo.чек) filter (where rop_title_product(c.title) = 'БФЛ')::numeric as чек_бфл_сумма,
    count(*) filter (where rop_title_product(c.title) = 'БФЛ' and mo.чек is not null)::integer as чек_бфл_сделок
  from договоры_строки c
  join rop_managers m on m.manager_name = c.assigned_by_name and m.team is not null
  left join rop_deal_money mo on mo.deal_id = c.deal_id
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
  coalesce(g.окс_вбфл, 0) as окс_вбфл,
  coalesce(g.окс_неопознано, 0) as окс_неопознано,
  coalesce(g.окс_аз, 0) as окс_аз,
  coalesce(g.окс_вки, 0) as окс_вки,
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
-- ПРОВЕРКИ
--
-- 1. Сколько склеилось. Левое — строк в таблице, правое — договоров после
--    склейки. Разница и есть закрытые копии; за ноябрь ожидается около 21.
--
-- select
--   (select count(*) from rop_deals
--     where category_id = 34 and paid_at is not null
--       and (paid_at at time zone 'Europe/Moscow')::date >= date '2026-11-01') as карточек,
--   (select sum(окс_всего) from rop_daily where дата >= date '2026-11-01') as договоров;
--
-- 2. Что лежит внутри договоров, не опознанных как банкротство. Здесь и
--    проявится новый продукт, которому пора завести плитку.
--
-- select d.deal_id, d.title,
--        coalesce(string_agg(p.product_name, ' | ' order by p.id),
--                 '— позиций нет —') as состав
-- from rop_deals d
-- left join rop_deal_products p on p.deal_id = d.deal_id
-- where d.category_id = 34 and d.paid_at is not null
--   and (d.paid_at at time zone 'Europe/Moscow')::date >= date '2026-11-01'
--   and rop_title_product(d.title) = 'прочее'
-- group by 1, 2 order by 1;
--
-- 3. Какие пары склеились — посмотреть глазами. Здесь перечислены
--    карточки с одним клиентом и одной датой; в витрине от каждой такой
--    группы остаётся одна строка. Если в списке окажется пара РАЗНЫХ
--    людей с похожими именами, склейку придётся ужесточить.
--
-- select coalesce(rop_client_key(title), 'сделка ' || deal_id) as клиент,
--        (paid_at at time zone 'Europe/Moscow')::date as дата,
--        count(*) as карточек,
--        string_agg(deal_id::text, ', ' order by deal_id) as сделки
-- from rop_deals
-- where category_id = 34 and paid_at is not null
--   and (paid_at at time zone 'Europe/Moscow')::date >= date '2026-11-01'
-- group by 1, 2 having count(*) > 1 order by 3 desc;
-- ============================================================================
