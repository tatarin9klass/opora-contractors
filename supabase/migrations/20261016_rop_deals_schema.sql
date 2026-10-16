-- ============================================================================
-- Кабинет РОПа: построчные сделки воронки «Продажа БФЛ» (категория 34).
--
-- ЗАЧЕМ НОВЫЕ ТАБЛИЦЫ. Всё, что нужно РОПу, живёт в сделках, а в приложении
-- сделок нет: bitrix-import считает их количество за день и складывает в
-- daily_facts. По агрегату нельзя ни разложить передачу в ОКС на АЗ и ВКИ,
-- ни посчитать средний чек, ни построить воронку по менеджерам.
--
-- ТРИ ТАБЛИЦЫ, А НЕ ОДНА, И ЭТО НЕ УСЛОЖНЕНИЕ:
--
--   rop_deals          — сама сделка: стадия, сумма, ответственный, источник;
--   rop_deal_products  — товарные позиции: из них и только из них считаются
--                        АЗ, ВКИ, ФПА и средний чек;
--   rop_deal_stages    — история переходов: без неё конверсии воронки
--                        бессмысленны.
--
-- ПРО ИСТОРИЮ ОТДЕЛЬНО. Стадия в карточке — это ГДЕ СДЕЛКА СЕЙЧАС, а не
-- где она была. Сделка, дошедшая до оплаты, стоит на «Передано в ОКС», и в
-- «ИКП сформирован» её больше нет. Считать конверсию «встреча → ИКП» по
-- текущей стадии значит считать застрявших: чем лучше работает отдел, тем
-- хуже выглядит конверсия. Поэтому история переходов хранится построчно, и
-- все конверсии считаются как «сколько сделок ПРОШЛО через этап».
--
-- ЧТО НЕ ТРОГАЕТСЯ. Направление БФЛ в управленческом учёте остаётся как
-- есть: bfl_lead_timings, daily_facts и все витрины направления не меняются
-- ни на строку. Лиды с префиксами OP, R и agbfl в базу не добавляются —
-- источник сделки приходит вместе с самой сделкой (см. комментарий к
-- rop_deals.source_name).
-- ============================================================================

-- ============================================================================
-- Справочник префиксов источников
--
-- РОПу нужна развёртка на две группы: маркетинг и рекомендации. Префиксов
-- при этом четыре, и три из них означают одно и то же — у заявки от агента,
-- от отдела продаж и по рекомендации другой уровень лояльности, чем у
-- рекламной, но между собой они схожи.
--
-- ТАБЛИЦА, А НЕ УСЛОВИЕ В КОДЕ: точные написания префиксов в справочнике
-- Битрикса я не проверял построчно, а появление нового префикса — вопрос
-- времени. Поправить строку в таблице дешевле, чем выпускать миграцию.
-- ============================================================================
create table if not exists rop_source_prefixes (
  prefix text primary key,
  source_group text not null check (source_group in ('маркетинг', 'рекомендации', 'прочее')),
  note text
);

insert into rop_source_prefixes (prefix, source_group, note) values
  ('ofbfl', 'маркетинг',    'подрядчики и реклама направления БФЛ'),
  ('op',    'рекомендации', 'отдел продаж завёл лид сам'),
  ('r',     'рекомендации', 'рекомендации'),
  ('agbfl', 'рекомендации', 'агенты')
on conflict (prefix) do update set
  source_group = excluded.source_group, note = excluded.note;

-- Группа источника по его названию. Берётся самый длинный подошедший
-- префикс: иначе «ofbfl-…» рискует совпасть с коротким правилом раньше, чем
-- со своим собственным.
create or replace function rop_source_group(source_name text)
returns text language sql stable as $$
  select coalesce(
    (select p.source_group
     from rop_source_prefixes p
     where lower(coalesce(source_name, '')) like p.prefix || '%'
     order by length(p.prefix) desc
     limit 1),
    'прочее'
  );
$$;

-- ============================================================================
-- Группа продукта
--
-- ФПА вынесен в собственную группу, потому что по прямому указанию
-- руководителя направления он не входит НИКУДА: ни в средний чек, ни в
-- показатели передачи в ОКС. Он продаётся отдельно и до банкротства, его
-- задача — проверить, подходит ли клиент. Показывается отдельной метрикой.
--
-- Депозит АУ отнесён к БФЛ: это часть продукта, просто по закону
-- оплачивается отдельным платежом.
--
-- «Банкротство через МФЦ» и «Реструктуризация долгов» тоже БФЛ — по
-- решению руководителя направления.
-- ============================================================================
create or replace function rop_product_group(product_name text)
returns text language sql immutable as $$
  select case
    when lower(coalesce(product_name, '')) like '%финансово-правов%' then 'ФПА'
    when lower(coalesce(product_name, '')) like '%адвокатск%'        then 'АЗ'
    when lower(coalesce(product_name, '')) like '%вки%'
      or lower(coalesce(product_name, '')) like '%кредитной истории%' then 'ВКИ'
    when lower(coalesce(product_name, '')) like '%банкротств%'
      or lower(coalesce(product_name, '')) like '%реструктуризац%'
      or lower(coalesce(product_name, '')) like '%депозит ау%'        then 'БФЛ'
    else 'прочее'
  end;
$$;

-- ============================================================================
-- Сделки
-- ============================================================================
create table if not exists rop_deals (
  deal_id bigint primary key,
  title text,
  category_id integer,
  stage_id text,
  stage_name text,
  -- Сумма сделки целиком, как её считает Битрикс. Для среднего чека НЕ
  -- используется: чек собирается из позиций за вычетом ФПА, иначе анализ
  -- за 12 500 ₽ попадал бы в один ряд с банкротством за 300 000 ₽.
  opportunity numeric,
  assigned_by_id bigint,
  assigned_by_name text,
  lead_id bigint,
  -- Источник приходит из лида-родителя, а если лида нет — из самой сделки.
  -- Храним название целиком: по нему же считается группа, и при смене
  -- правил группировки ничего переимпортировать не придётся.
  source_name text,
  date_create timestamptz,
  closedate timestamptz,
  moved_time timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists rop_deals_stage_idx on rop_deals(stage_id);
create index if not exists rop_deals_created_idx on rop_deals(date_create);
create index if not exists rop_deals_manager_idx on rop_deals(assigned_by_name);

comment on column rop_deals.source_name is
  'Название источника лида-родителя (или самой сделки, если лида нет). '
  'Группа считается из него функцией rop_source_group, а не хранится: так '
  'правка справочника префиксов действует сразу, без переимпорта.';

-- ============================================================================
-- Товарные позиции
--
-- Есть не у всех сделок: позиции появляются, когда формируют ИКП и договор.
-- По выгрузке за сентябрь — у 247 сделок из 569. Это не потеря данных, а
-- отражение того, что до оформления дошла меньшая часть; средний чек и
-- считается по ним.
-- ============================================================================
create table if not exists rop_deal_products (
  id bigserial primary key,
  deal_id bigint not null references rop_deals(deal_id) on delete cascade,
  product_name text not null,
  price numeric,
  quantity numeric,
  total numeric
);

create index if not exists rop_deal_products_deal_idx on rop_deal_products(deal_id);

-- ============================================================================
-- История переходов по стадиям
--
-- Одна строка — один факт «сделка побывала на этой стадии». Повторные
-- возвраты на ту же стадию тоже строки: сделку могут откатить назад, и это
-- само по себе показатель.
-- ============================================================================
create table if not exists rop_deal_stages (
  id bigserial primary key,
  deal_id bigint not null references rop_deals(deal_id) on delete cascade,
  stage_id text not null,
  stage_name text,
  entered_at timestamptz
);

create index if not exists rop_deal_stages_deal_idx on rop_deal_stages(deal_id);
create index if not exists rop_deal_stages_stage_idx on rop_deal_stages(stage_id);

-- ============================================================================
-- Планы
--
-- Задаются руками на месяц: отдельно на отдел и отдельно на каждого
-- менеджера. Метрики перечислены ограничением, чтобы опечатка в названии не
-- создала молча невидимый план, который никогда не сойдётся с фактом.
--
-- Брак задаётся НЕ числом, а нормой в процентах, и сравнивается наоборот:
-- у него зелёная зона снизу. Это единственный показатель с обратным знаком,
-- и путать его с остальными нельзя.
-- ============================================================================
create table if not exists rop_plans (
  id bigserial primary key,
  period date not null,
  -- NULL = план на отдел целиком. Иначе — фамилия менеджера, как она
  -- приходит из Битрикса в rop_deals.assigned_by_name.
  manager_name text,
  metric text not null check (metric in (
    'оксвсего', 'оксаз', 'оксвки', 'встречи', 'среднийчек', 'бракнорма'
  )),
  value numeric not null,
  updated_at timestamptz not null default now(),
  updated_by text
);

create unique index if not exists rop_plans_key_idx
  on rop_plans(period, coalesce(manager_name, ''), metric);

comment on table rop_plans is
  'Планы отдела продаж на месяц. manager_name = NULL — план на отдел. '
  'Метрика «бракнорма» задаётся в процентах и означает «не выше», '
  'остальные — «не ниже».';

-- ============================================================================
-- Состояние импорта
-- ============================================================================
create table if not exists rop_sync_state (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- Права
--
-- Пока — только сотрудники. Роль РОПа и её вьюхи заводятся следующей
-- миграцией, когда будет что показывать.
-- ============================================================================
do $$
declare t text;
begin
  foreach t in array array[
    'rop_deals', 'rop_deal_products', 'rop_deal_stages',
    'rop_plans', 'rop_sync_state', 'rop_source_prefixes'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "staff_select" on %I', t);
    execute format('create policy "staff_select" on %I for select using (is_staff())', t);
    execute format('drop policy if exists "admin_write" on %I', t);
    execute format('create policy "admin_write" on %I for all using (is_admin()) with check (is_admin())', t);
  end loop;
end $$;
