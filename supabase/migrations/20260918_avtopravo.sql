-- ============================================================================
-- Направление АВТОПРАВО (+ АВАРКОМ) — отдельный контур, полностью независимый
-- от БФЛ. Ни одна таблица/вьюха БФЛ этой миграцией не трогается: всё новое
-- лежит в собственных таблицах с префиксом ap_.
--
-- Логика направления (зафиксировано на брифе):
--   * лиды берутся из воронки лидов ПО ПРЕФИКСУ ИСТОЧНИКА (avtpr / avrkm),
--     стадия лида игнорируется полностью;
--   * лид относится к месяцу по ДАТЕ СОЗДАНИЯ;
--   * договор = сделка, которая СЕЙЧАС стоит на договорной стадии воронки
--     8 ("Автоправо. Продажи") или 36 ("Аварийные комиссары");
--   * договор относится к месяцу по дате создания ЛИДА, из которого сделка
--     выросла (LEAD_ID), и только если лида нет — по дате создания сделки;
--   * считаем именно сделки, а не лиды: у одного лида может быть несколько
--     договоров, и исторически важен сам факт заключения каждого;
--   * период — месяц. Планов и зон внимания в этом направлении нет.
-- ============================================================================

-- --- Каналы (в БФЛ это "подрядчики", здесь — рекламные каналы) --------------
create table if not exists ap_channels (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  -- Группа каналов на экране: АВТОПРАВО или АВАРКОМ.
  direction text not null check (direction in ('avtpr', 'avrkm')),
  sort_order integer not null default 0,
  created_at timestamptz not null default now()
);

-- --- Источники Битрикса, разложенные по каналам -----------------------------
-- bitrix_name — ровно то имя источника, что приходит из crm.status.list
-- (ENTITY_ID = SOURCE). channel_id = null означает "источник появился в
-- Битриксе, но ещё не привязан к каналу" — такие показываются на странице
-- импорта, чтобы их можно было привязать руками.
create table if not exists ap_sources (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid references ap_channels(id) on delete set null,
  bitrix_name text not null unique,
  direction text not null check (direction in ('avtpr', 'avrkm')),
  first_seen_at timestamptz not null default now()
);

create index if not exists ap_sources_channel_idx on ap_sources(channel_id);

-- --- Лиды -------------------------------------------------------------------
-- Одна строка на лид Битрикса. Стадия лида не хранится и не используется:
-- по ТЗ направления лид считается лидом просто по факту существования.
create table if not exists ap_leads (
  lead_id bigint primary key,
  source_name text not null,
  direction text not null check (direction in ('avtpr', 'avrkm')),
  created_date date not null,
  synced_at timestamptz not null default now()
);

create index if not exists ap_leads_month_idx on ap_leads(created_date);
create index if not exists ap_leads_source_idx on ap_leads(source_name);

-- --- Сделки -----------------------------------------------------------------
-- Храним текущую стадию, а не флаг "договор" — так список договорных стадий
-- можно поменять одним INSERT/DELETE в ap_contract_stages, без передеплоя
-- Edge Function и без перезаливки сделок.
create table if not exists ap_deals (
  deal_id bigint primary key,
  lead_id bigint,
  category_id integer not null,
  stage_id text not null,
  source_name text,
  deal_created_date date not null,
  synced_at timestamptz not null default now()
);

create index if not exists ap_deals_lead_idx on ap_deals(lead_id);
create index if not exists ap_deals_stage_idx on ap_deals(category_id, stage_id);

-- --- Договорные стадии ------------------------------------------------------
create table if not exists ap_contract_stages (
  category_id integer not null,
  stage_id text not null,
  stage_name text,
  primary key (category_id, stage_id)
);

-- --- Расход по каналу за месяц (вводится вручную) ---------------------------
-- month — всегда первое число месяца.
create table if not exists ap_monthly_expenses (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references ap_channels(id) on delete cascade,
  month date not null,
  spend numeric not null default 0,
  updated_at timestamptz not null default now(),
  unique (channel_id, month)
);

-- --- Файлы канала (вкладка "Файлы" в паспорте канала) -----------------------
create table if not exists ap_channel_files (
  id uuid primary key default gen_random_uuid(),
  channel_id uuid not null references ap_channels(id) on delete cascade,
  file_name text not null,
  file_url text not null,
  file_type text,
  uploaded_by text,
  uploaded_at timestamptz not null default now()
);

create index if not exists ap_channel_files_channel_idx on ap_channel_files(channel_id);

-- --- Курсор синхронизации ---------------------------------------------------
-- Импорт за 9 месяцев не укладывается в один вызов Edge Function, поэтому
-- он идёт фазами и продолжается с сохранённой позиции.
create table if not exists ap_sync_state (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

-- ============================================================================
-- Витрина: лиды и договоры по (месяц × источник)
-- ============================================================================
-- security_invoker = true — вьюха читает таблицы правами вызывающего, то есть
-- RLS ниже реально работает и на неё тоже.
drop view if exists ap_monthly_stats;
create view ap_monthly_stats with (security_invoker = true) as
with lead_months as (
  select
    date_trunc('month', created_date)::date as month,
    source_name,
    count(*)::integer as leads
  from ap_leads
  group by 1, 2
),
contract_months as (
  select
    -- Договор привязывается к месяцу создания ЛИДА; сделка без лида
    -- (заведена руками) — по своей дате создания.
    date_trunc('month', coalesce(l.created_date, d.deal_created_date))::date as month,
    coalesce(l.source_name, d.source_name) as source_name,
    count(*)::integer as contracts
  from ap_deals d
  join ap_contract_stages cs
    on cs.category_id = d.category_id and cs.stage_id = d.stage_id
  left join ap_leads l on l.lead_id = d.lead_id
  where coalesce(l.source_name, d.source_name) is not null
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
-- RLS — ровно та же схема, что у БФЛ: читать может любой залогиненный,
-- писать только admin. Edge Function пишет через service_role и RLS не
-- подчиняется, поэтому импорт работает без отдельных политик.
-- ============================================================================
do $$
declare
  tbl text;
  tables text[] := array[
    'ap_channels', 'ap_sources', 'ap_leads', 'ap_deals',
    'ap_contract_stages', 'ap_monthly_expenses', 'ap_channel_files',
    'ap_sync_state'
  ];
begin
  foreach tbl in array tables loop
    execute format('alter table if exists %I enable row level security', tbl);
    execute format('drop policy if exists "authenticated_select" on %I', tbl);
    execute format('create policy "authenticated_select" on %I for select using (auth.uid() is not null)', tbl);
    execute format('drop policy if exists "admin_write" on %I', tbl);
    execute format('create policy "admin_write" on %I for all using (is_admin()) with check (is_admin())', tbl);
  end loop;
end $$;

-- ============================================================================
-- СИДЫ
-- ============================================================================

-- --- Договорные стадии воронки 8 "Автоправо. Продажи" -----------------------
insert into ap_contract_stages (category_id, stage_id, stage_name) values
  (8, 'C8:UC_MLEY4D', 'Подписали договор'),
  (8, 'C8:15',        'Передача в юр. отдел'),
  (8, 'C8:1',         'Выплата получена'),
  (8, 'C8:18',        'Ждём разбор'),
  (8, 'C8:19',        'Судебное производство'),
  (8, 'C8:WON',       'Успех')
on conflict (category_id, stage_id) do nothing;

-- --- Договорные стадии воронки 36 "Аварийные комиссары" ---------------------
insert into ap_contract_stages (category_id, stage_id, stage_name) values
  (36, 'C36:UC_KYXKL2', 'Подписали договор'),
  (36, 'C36:3',         'Договорная стадия 3'),
  (36, 'C36:4',         'Договорная стадия 4'),
  (36, 'C36:5',         'Договорная стадия 5'),
  (36, 'C36:6',         'Договорная стадия 6'),
  (36, 'C36:UC_LKTAXD', 'Договорная стадия'),
  (36, 'C36:UC_2D12J9', 'Договорная стадия'),
  (36, 'C36:UC_SW7C0N', 'Договорная стадия'),
  (36, 'C36:10',        'Договорная стадия 10'),
  (36, 'C36:11',        'Договорная стадия 11'),
  (36, 'C36:WON',       'Успех')
on conflict (category_id, stage_id) do nothing;

-- --- Каналы -----------------------------------------------------------------
insert into ap_channels (name, direction, sort_order) values
  ('2.0 WDS Marketing',        'avtpr', 20),
  ('2.1 Заявки сайт опора',    'avtpr', 21),
  ('2.2 Заявки 2гис',          'avtpr', 22),
  ('2.4 Заявки автоюрист54',   'avtpr', 24),
  ('2.6 Радио',                'avtpr', 26),
  ('2.7 Яндекс',               'avtpr', 27),
  ('2.8 Прочее',               'avtpr', 28),
  ('2.9 Суетин',               'avtpr', 29),
  ('3.0 АВАРКОМ',              'avrkm', 30)
on conflict (name) do nothing;

-- --- Привязка источников к каналам ------------------------------------------
-- Только источники avtpr: все avrkm-источники Edge Function привязывает к
-- каналу "3.0 АВАРКОМ" автоматически при обнаружении (их там всего один
-- канал, перечислять имена вручную незачем).
insert into ap_sources (channel_id, bitrix_name, direction)
select c.id, v.bitrix_name, 'avtpr'
from (values
  ('2.0 WDS Marketing',      'Avtpr. WDS Marketing'),
  ('2.1 Заявки сайт опора',  'Avtpr. Сайт Опора (ЗВ)'),
  ('2.1 Заявки сайт опора',  'Avtpr. Сайт Опора (заявка)'),
  ('2.1 Заявки сайт опора',  'Avtpr. звонок на мобильный'),
  ('2.2 Заявки 2гис',        'Avtpr. 2ГИС Опора (ЗВ)'),
  ('2.2 Заявки 2гис',        'Avtpr. 2ГИС Авангард (ЗВ)'),
  ('2.4 Заявки автоюрист54', 'Avtpr. Автоюрист-54 (ЗВ)'),
  ('2.4 Заявки автоюрист54', 'Avtpr. Автоюрист-54 (заявка)'),
  ('2.6 Радио',              'Avtpr. Радио/Я.Баннер (ЗВ)'),
  ('2.7 Яндекс',             'Avtpr. Я.Биз Опора (ЗВ)'),
  ('2.7 Яндекс',             'Avtpr. Я.Услуги'),
  ('2.8 Прочее',             'Avtpr. Рекомендация (от кого указать в комментарии)'),
  ('2.8 Прочее',             'Avtpr. Другое (см.комментарий)'),
  ('2.8 Прочее',             'Avtpr. WAZZUP: Max - АП ОП'),
  ('2.8 Прочее',             'Avtpr. МДБ'),
  ('2.8 Прочее',             'Avtpr. Перевод из Аварком'),
  ('2.8 Прочее',             'Avtpr. Яма от комиссара'),
  ('2.9 Суетин',             'Avtpr. Suetin')
) as v(channel_name, bitrix_name)
join ap_channels c on c.name = v.channel_name
on conflict (bitrix_name) do update set channel_id = excluded.channel_id;

-- --- Расход по каналам, январь–июль 2026 (из Roistat, руками) ---------------
insert into ap_monthly_expenses (channel_id, month, spend)
select c.id, v.month::date, v.spend
from (values
  ('2.0 WDS Marketing',      '2026-01-01', 225450),
  ('2.0 WDS Marketing',      '2026-02-01', 267450),
  ('2.0 WDS Marketing',      '2026-03-01', 225450),
  ('2.0 WDS Marketing',      '2026-04-01',  30450),
  ('2.0 WDS Marketing',      '2026-05-01', 190450),
  ('2.0 WDS Marketing',      '2026-06-01', 139450),
  ('2.0 WDS Marketing',      '2026-07-01', 213900),

  ('2.1 Заявки сайт опора',  '2026-01-01', 137300),
  ('2.1 Заявки сайт опора',  '2026-02-01', 187833),
  ('2.1 Заявки сайт опора',  '2026-03-01', 175000),
  ('2.1 Заявки сайт опора',  '2026-04-01', 260000),
  ('2.1 Заявки сайт опора',  '2026-05-01', 243500),
  ('2.1 Заявки сайт опора',  '2026-06-01', 162500),
  ('2.1 Заявки сайт опора',  '2026-07-01', 135000),

  ('2.2 Заявки 2гис',        '2026-01-01',      0),
  ('2.2 Заявки 2гис',        '2026-02-01',      0),
  ('2.2 Заявки 2гис',        '2026-03-01', 112007),
  ('2.2 Заявки 2гис',        '2026-04-01', 112577),
  ('2.2 Заявки 2гис',        '2026-05-01', 112577),
  ('2.2 Заявки 2гис',        '2026-06-01', 112577),
  ('2.2 Заявки 2гис',        '2026-07-01', 410997),

  ('2.4 Заявки автоюрист54', '2026-01-01',  22000),
  ('2.4 Заявки автоюрист54', '2026-02-01',  22000),
  ('2.4 Заявки автоюрист54', '2026-03-01',  22000),
  ('2.4 Заявки автоюрист54', '2026-04-01',  22000),
  ('2.4 Заявки автоюрист54', '2026-05-01',  22000),
  ('2.4 Заявки автоюрист54', '2026-06-01',  22000),
  ('2.4 Заявки автоюрист54', '2026-07-01',  22000),

  ('2.6 Радио',              '2026-01-01', 190324),
  ('2.6 Радио',              '2026-02-01', 360551),
  ('2.6 Радио',              '2026-03-01', 393790),
  ('2.6 Радио',              '2026-04-01', 443463),
  ('2.6 Радио',              '2026-05-01', 368061),
  ('2.6 Радио',              '2026-06-01', 172260),
  ('2.6 Радио',              '2026-07-01', 110000),

  ('2.7 Яндекс',             '2026-01-01',      0),
  ('2.7 Яндекс',             '2026-02-01',      0),
  ('2.7 Яндекс',             '2026-03-01',  35333),
  ('2.7 Яндекс',             '2026-04-01',  15333),
  ('2.7 Яндекс',             '2026-05-01',  15333),
  ('2.7 Яндекс',             '2026-06-01',  23000),
  ('2.7 Яндекс',             '2026-07-01',  23000),

  ('2.8 Прочее',             '2026-01-01',  10000),
  ('2.8 Прочее',             '2026-02-01',      0),
  ('2.8 Прочее',             '2026-03-01',      0),
  ('2.8 Прочее',             '2026-04-01',      0),
  ('2.8 Прочее',             '2026-05-01',      0),
  ('2.8 Прочее',             '2026-06-01',   8000),
  ('2.8 Прочее',             '2026-07-01',      0),

  ('2.9 Суетин',             '2026-01-01',      0),
  ('2.9 Суетин',             '2026-02-01',      0),
  ('2.9 Суетин',             '2026-03-01',      0),
  ('2.9 Суетин',             '2026-04-01',      0),
  ('2.9 Суетин',             '2026-05-01',      0),
  ('2.9 Суетин',             '2026-06-01',      0),
  ('2.9 Суетин',             '2026-07-01',      0),

  ('3.0 АВАРКОМ',            '2026-01-01', 557727),
  ('3.0 АВАРКОМ',            '2026-02-01', 672260),
  ('3.0 АВАРКОМ',            '2026-03-01', 685760),
  ('3.0 АВАРКОМ',            '2026-04-01', 735960),
  ('3.0 АВАРКОМ',            '2026-05-01', 670608),
  ('3.0 АВАРКОМ',            '2026-06-01', 800350),
  ('3.0 АВАРКОМ',            '2026-07-01', 881750)
) as v(channel_name, month, spend)
join ap_channels c on c.name = v.channel_name
on conflict (channel_id, month) do update set spend = excluded.spend, updated_at = now();
