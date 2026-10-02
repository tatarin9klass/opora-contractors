-- ============================================================================
-- Сверка источников внутри реальных данных вкладки «Каналы».
--
-- ГЛАВНАЯ ЛОВУШКА, которую здесь обходим. Сверка покрывает только ВЫИГРАННЫЕ
-- сделки — 120 штук, — а лидов не касается. Если просто перевесить договоры,
-- цифры станут не точнее, а хуже:
--   * у «Рекомендации» останутся все лиды, но уйдут договоры — конверсия
--     просядет на ровном месте;
--   * у новых строк появятся договоры при нуле лидов — конверсия
--     бесконечная, CPO нулевой.
--
-- Поэтому сделка переносится ВМЕСТЕ СО СВОИМ ЛИДОМ. У каждой сделки есть
-- lead_id, и если источник сделки подменили, то и у лида он подменён — это
-- одна и та же запись в Битриксе. Лид и договор уезжают парой, конверсия
-- остаётся осмысленной.
--
-- ОСТАТОЧНОЕ ИСКАЖЕНИЕ НАЗЫВАЮ ПРЯМО: лиды из того же бага, которые НЕ
-- выиграли, в разборе не представлены и останутся в «Рекомендации». Доля
-- рекомендаций по лидам будет завышена. Полностью это лечится только правкой
-- робота перевода, а не данными.
--
-- МЕСЯЦ НЕ МЕНЯЕТСЯ. Логика прежняя: договор относится к месяцу создания
-- породившего его лида, лид — к своему. Сверка меняет только источник,
-- поэтому помесячное распределение остаётся тем же, что и в ap_monthly_stats.
--
-- ОБРАТИМОСТЬ. Базовая витрина ap_monthly_stats не трогается. Исправленная
-- лежит рядом, и на экране переключается тумблером. Иначе через месяц никто
-- не вспомнит, почему приложение не сходится с Битриксом.
-- ============================================================================

-- --- Новые каналы -----------------------------------------------------------
-- Помечаются флагом from_correction, чтобы на экране было видно: эти группы
-- появились из ручного разбора, а не из Битрикса, и расхода по ним нет.
alter table ap_channels add column if not exists from_correction boolean not null default false;

insert into ap_channels (name, direction, sort_order, from_correction) values
  ('2.10 Рекомендации',       'avtpr', 210, true),
  ('2.11 Перевод из БФЛ',     'avtpr', 211, true),
  ('2.12 Повторные обращения','avtpr', 212, true)
on conflict (name) do update set from_correction = excluded.from_correction,
                                 sort_order = excluded.sort_order;

-- --- Рекомендатели как источники внутри канала «Рекомендации» ---------------
-- Это постоянные клиенты и сотрудники, которые регулярно приводят знакомых.
-- В Битриксе все они лежат одним источником, поэтому разделить их можно
-- только здесь.
insert into ap_sources (channel_id, bitrix_name, direction)
select c.id, v.n, 'avtpr' from (values
  ('Рекомендация: Артем Квашнин'),
  ('Рекомендация: Евгений Птицын'),
  ('Рекомендация: Константин Слюсарь'),
  ('Рекомендация: Саша Камалетдинов'),
  ('Рекомендация: Леонид Васильев'),
  ('Рекомендация: Александр Павнов'),
  ('Рекомендация: Артем Игоревич'),
  ('Рекомендация: Александр Тертюк'),
  ('Рекомендация: Валерия Лымарь'),
  ('Рекомендация: Женя Архипов'),
  ('Рекомендация: Клемещев Александр'),
  ('Рекомендация: Михаил'),
  ('Рекомендация: Николай Землянский'),
  ('Рекомендация: товарищ (имя не указано)'),
  ('Рекомендация: знакомые (имя не указано)')
) as v(n)
cross join ap_channels c where c.name = '2.10 Рекомендации'
on conflict (bitrix_name) do update set channel_id = excluded.channel_id;

-- --- Переводы из БФЛ --------------------------------------------------------
-- ВНИМАНИЕ: эта группа отменена следующей миграцией 20261005_ap_merge_transfers.
-- По решению руководителя направления такие сделки зачисляются в одноимённые
-- каналы Автоправа. Блок оставлен, чтобы миграции накатывались по порядку на
-- чистую базу; результат его работы тут же переписывается.
insert into ap_sources (channel_id, bitrix_name, direction)
select c.id, v.n, 'avtpr' from (values
  ('Перевод из БФЛ: ofbfl-2ГИС ОПОРА (ЗВ)'),
  ('Перевод из БФЛ: ofbfl-Сайт ОПОРА (заявка)'),
  ('Перевод из БФЛ: ofbfl-Опора Я.Бизнес (ЗВ)')
) as v(n)
cross join ap_channels c where c.name = '2.11 Перевод из БФЛ'
on conflict (bitrix_name) do update set channel_id = excluded.channel_id;

-- --- Повторные обращения ----------------------------------------------------
-- Это удержание, а не привлечение. Смешивать с каналами нельзя: любая
-- стоимость лида после такого смешения врёт.
insert into ap_sources (channel_id, bitrix_name, direction)
select c.id, 'Avtpr. Повторное обращение', 'avtpr'
from ap_channels c where c.name = '2.12 Повторные обращения'
on conflict (bitrix_name) do update set channel_id = excluded.channel_id;

-- --- Рекомендации в сверке переводим на поимённые источники -----------------
update ap_deal_source_overrides
set real_source = 'Рекомендация: ' || recommender
where kind = 'рекомендация' and recommender is not null;

-- ============================================================================
-- Исправленная витрина — та же, что ap_monthly_stats, но с учётом сверки
-- ============================================================================
drop view if exists ap_monthly_stats_corrected;
create view ap_monthly_stats_corrected with (security_invoker = true) as
with ov as (
  select o.deal_id, d.lead_id, o.real_source
  from ap_deal_source_overrides o
  join ap_deals d on d.deal_id = o.deal_id
  where o.real_source is not null
),
-- У лида теоретически может быть несколько сделок с разными исправлениями.
-- Берём минимальный по алфавиту, чтобы результат был детерминированным и лид
-- не задвоился.
lead_src as (
  select lead_id, min(real_source) as real_source
  from ov where lead_id is not null
  group by lead_id
),
lead_months as (
  select
    date_trunc('month', l.created_date)::date as month,
    coalesce(ls.real_source, l.source_name) as source_name,
    count(*)::integer as leads
  from ap_leads l
  left join lead_src ls on ls.lead_id = l.lead_id
  group by 1, 2
),
contract_months as (
  select
    date_trunc('month', coalesce(l.created_date, d.deal_created_date))::date as month,
    coalesce(o.real_source, l.source_name, d.source_name) as source_name,
    count(*)::integer as contracts
  from ap_deals d
  join ap_contract_stages cs
    on cs.category_id = d.category_id and cs.stage_id = d.stage_id
  left join ap_leads l on l.lead_id = d.lead_id
  left join ap_deal_source_overrides o on o.deal_id = d.deal_id
  where coalesce(o.real_source, l.source_name, d.source_name) is not null
  group by 1, 2
),
keys as (
  select month, source_name from lead_months
  union
  select month, source_name from contract_months
)
select
  k.month,
  k.source_name,
  coalesce(lm.leads, 0) as leads,
  coalesce(cm.contracts, 0) as contracts
from keys k
left join lead_months lm on lm.month = k.month and lm.source_name = k.source_name
left join contract_months cm on cm.month = k.month and cm.source_name = k.source_name;

-- ============================================================================
-- Помесячно: куда уехали договоры после сверки
--
-- Нужна, чтобы проверить главное требование — что сделки распределились по
-- месяцам правильно, а не свалились в одну кучу.
-- ============================================================================
drop view if exists ap_correction_by_month;
create view ap_correction_by_month with (security_invoker = true) as
select
  date_trunc('month', coalesce(l.created_date, d.deal_created_date))::date as месяц,
  coalesce(l.source_name, d.source_name, '— пусто —') as было,
  o.real_source as стало,
  o.kind as тип,
  count(*)::integer as сделок
from ap_deal_source_overrides o
join ap_deals d on d.deal_id = o.deal_id
left join ap_leads l on l.lead_id = d.lead_id
where o.real_source is not null
group by 1, 2, 3, 4;
