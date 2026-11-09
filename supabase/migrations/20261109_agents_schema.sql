-- ============================================================================
-- Кабинет руководителя агентской сети: роль и схема.
--
-- ЧТО ТАКОЕ АГЕНТ. Элемент смарт-процесса 1120 («Агенты»), воронка 108.
-- Лид и сделка ссылаются на него полем PARENT_ID_1120 — это настоящая
-- связь, а не текст, поэтому ФИО берётся из названия элемента и не может
-- разъехаться с карточкой агента.
--
-- ДВА СЛУЖЕБНЫХ ЭЛЕМЕНТА ВЕДУТ СЕБЯ КАК АГЕНТЫ, НО АГЕНТАМИ НЕ ЯВЛЯЮТСЯ:
-- «Агент не найден» (id 5206) и «Без агента» (id 5198). Они лежат в тех же
-- стадиях, что живые люди, и портят наполненность воронки: на день
-- разработки «Агент не найден» стоял в стадии «Фанат (11+ клиентов)» и был
-- там единственным. То есть канбан показывал одного фаната, которого нет.
-- Поэтому у карточки есть вид, и воронка считает только вид «агент».
--
-- «Агент не найден» при этом остаётся в статистике приведённого: лид
-- действительно пришёл через агента, просто его не опознали. По указанию
-- руководителя такие лиды учитываются только там, где в источнике есть
-- префикс agbfl, — иначе в агентскую статистику попадёт весь поток, в
-- котором поле просто забыли заполнить.
--
-- «Без агента» — это покупка самим агентом для себя (например ВКИ). К
-- приведённому отношения не имеет и в статистику не идёт.
-- ============================================================================

-- --- Роль -------------------------------------------------------------------
alter table profiles drop constraint if exists profiles_role_check;
alter table profiles add constraint profiles_role_check
  check (role in ('admin', 'viewer', 'contractor', 'rop', 'agentlead'));

create or replace function is_agentlead()
returns boolean language sql security definer set search_path = public stable as $$
  select exists (select 1 from profiles where id = auth.uid() and role = 'agentlead');
$$;

comment on function is_agentlead() is
  'Залогинен руководитель агентской сети. Роль видит только агентов и то, '
  'что они привели: ни расходов, ни подрядчиков, ни отделов продаж.';

-- Сотрудники видят те же экраны: это позволяет проверить, что показано
-- руководителю сети, не заходя под его логином.
create or replace function agents_can_read()
returns boolean language sql security definer set search_path = public stable as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role in ('admin', 'viewer', 'agentlead')
  );
$$;

-- --- Карточки агентов -------------------------------------------------------
create table if not exists agent_cards (
  agent_id bigint primary key,
  title text,
  stage_id text,
  created_time timestamptz,
  -- 'агент' — живой человек; 'не найден' и 'без агента' — служебные
  -- элементы смарт-процесса. Вид проставляет импорт по названию.
  вид text not null default 'агент' check (вид in ('агент', 'не найден', 'без агента')),
  synced_at timestamptz not null default now()
);

create index if not exists agent_cards_stage_idx on agent_cards(stage_id);
create index if not exists agent_cards_вид_idx on agent_cards(вид);

-- --- Справочник стадий ------------------------------------------------------
--
-- Порядок стадий нужен экрану: воронка читается слева направо, и
-- сортировать её по количеству нельзя — смысл в последовательности.
-- Названия обновляет импорт, здесь они только затем, чтобы экран не был
-- пустым до первой синхронизации.
create table if not exists agent_stages (
  stage_id text primary key,
  name text not null,
  sort_order integer not null,
  -- «Успех» и «Провал» в наполненности не показываются: это выход из
  -- воронки, а не ступень роста.
  показывать boolean not null default true
);

insert into agent_stages (stage_id, name, sort_order, показывать) values
  ('DT1120_108:NEW',        'Агент (без клиентов)',   1, true),
  ('DT1120_108:PREPARATION','Новый (1 клиент)',       2, true),
  ('DT1120_108:CLIENT',     'Активный (2-5 клиентов)',3, true),
  ('DT1120_108:UC_ZA80SY',  'Профи (6-10 клиентов)',  4, true),
  ('DT1120_108:UC_H3QQW7',  'Фанат (11+ клиентов)',   5, true),
  ('DT1120_108:SUCCESS',    'Успех',                  6, false),
  ('DT1120_108:FAIL',       'Провал',                 7, false)
on conflict (stage_id) do update set
  name = excluded.name, sort_order = excluded.sort_order;

-- --- История переходов ------------------------------------------------------
--
-- РАДИ НЕЁ ВСЁ И ЗАТЕВАЛОСЬ. Текущая наполненность воронки отвечает на
-- вопрос «сколько сейчас», но не на вопрос «что изменилось». Запись истории
-- даёт вход на этап; выход считается как вход на любой следующий этап того
-- же агента. Без истории пришлось бы снимать слепки раз в сутки, и движение
-- появилось бы только с момента запуска, а не задним числом.
create table if not exists agent_stage_events (
  event_id bigint primary key,
  agent_id bigint not null,
  stage_id text not null,
  created_time timestamptz not null
);

create index if not exists agent_stage_events_agent_idx on agent_stage_events(agent_id, created_time);
create index if not exists agent_stage_events_time_idx on agent_stage_events(created_time);

-- --- Лиды агентов -----------------------------------------------------------
--
-- source_marker — НАЗВАНИЕ источника из Битрикса («ofbfl-Сайт ОПОРА»), а не
-- его код. Коды вида «95» или «RC_GENERATOR» префикса не содержат, а вся
-- агентская аналитика на префиксах и держится: по ним видно, что агент
-- передал лид не своим каналом.
create table if not exists agent_leads (
  lead_id bigint primary key,
  agent_id bigint,
  source_marker text,
  created_at timestamptz not null,
  qualified_at timestamptz,
  status_id text,
  synced_at timestamptz not null default now()
);

create index if not exists agent_leads_agent_idx on agent_leads(agent_id);
create index if not exists agent_leads_created_idx on agent_leads(created_at);
create index if not exists agent_leads_qualified_idx on agent_leads(qualified_at);

-- --- Сделки агентов ---------------------------------------------------------
--
-- Практически всё лежит в воронке 34 (на день разработки 1153 из 1154),
-- поэтому состав услуг берётся из rop_deal_products — той же таблицы, что
-- питает кабинет РОПа. Заводить второй источник правды о том, что такое
-- договор БФЛ, нельзя: определения разойдутся в первый же месяц.
create table if not exists agent_deals (
  deal_id bigint primary key,
  agent_id bigint,
  category_id integer,
  source_marker text,
  stage_id text,
  opportunity numeric,
  paid_at timestamptz,
  created_at timestamptz,
  synced_at timestamptz not null default now()
);

create index if not exists agent_deals_agent_idx on agent_deals(agent_id);
create index if not exists agent_deals_paid_idx on agent_deals(paid_at);

-- --- Курсор синхронизации ---------------------------------------------------
create table if not exists agent_sync_state (
  key text primary key,
  value text,
  updated_at timestamptz not null default now()
);

-- --- Префикс источника ------------------------------------------------------
--
-- Справочник берётся тот же, что у кабинета РОПа (rop_source_prefixes):
-- один список префиксов на приложение. Если завести второй, в одном экране
-- «agbfl» будет агентским, а в другом — нет.
-- ПРЕФИКС ОБЯЗАН ЗАКАНЧИВАТЬСЯ РАЗДЕЛИТЕЛЕМ, и это не придирка. Правило
-- «название начинается с префикса» ловит лишнее: источник «RC_GENERATOR»
-- начинается с «r» и попадал бы в рекомендации, хотя это открытая линия.
-- Проверено на живых данных — такие источники у агентов есть. Реальные
-- маркеры записаны через дефис: «ofbfl-Сайт ОПОРА», «agbfl-Петров».
create or replace function agent_prefix(source_name text)
returns text language sql stable as $$
  select coalesce(
    (select p.prefix
     from rop_source_prefixes p
     where lower(coalesce(source_name, '')) like p.prefix || '-%'
        or lower(coalesce(source_name, '')) = p.prefix
     order by length(p.prefix) desc
     limit 1),
    'прочее'
  );
$$;

comment on function agent_prefix(text) is
  'Префикс источника по его названию: «agbfl-Петров» → agbfl. Берётся '
  'самый длинный подошедший и только до дефиса, иначе «r» совпадает с '
  'чем попало.';

-- --- Доступ -----------------------------------------------------------------
--
-- Руководителю сети политик на этих таблицах не даётся вовсе: он читает
-- только витрины agents_portal_*, которые решают сами, что отдать. Дать ему
-- select на agent_deals значило бы отдать суммы всех сделок направления.
do $$
declare t text;
begin
  foreach t in array array[
    'agent_cards', 'agent_stages', 'agent_stage_events',
    'agent_leads', 'agent_deals', 'agent_sync_state'
  ] loop
    execute format('alter table %I enable row level security', t);
    execute format('drop policy if exists "staff_select" on %I', t);
    execute format('create policy "staff_select" on %I for select using (is_staff())', t);
    execute format('drop policy if exists "admin_write" on %I', t);
    execute format('create policy "admin_write" on %I for all using (is_admin()) with check (is_admin())', t);
  end loop;
end $$;

-- ============================================================================
-- КАК ЗАВЕСТИ РУКОВОДИТЕЛЯ АГЕНТСКОЙ СЕТИ
--
-- 1. Supabase Dashboard → Authentication → Users → Add user,
--    «Auto confirm user» включить, почта lybovetskaya.opora@gmail.com.
-- 2. Привязать роль:
--
--    insert into profiles (id, email, role)
--    select u.id, u.email, 'agentlead' from auth.users u
--    where lower(u.email) = 'lybovetskaya.opora@gmail.com'
--    on conflict (id) do update set role = 'agentlead', contractor_id = null;
--
-- 3. Проверить, что роль встала:
--
--    select email, role from profiles where role = 'agentlead';
--
-- ПРОВЕРКА ПОСЛЕ МИГРАЦИИ (должна вернуть семь таблиц с rowsecurity = true):
--
--    select tablename, rowsecurity from pg_tables
--    where schemaname = 'public' and tablename like 'agent\_%';
-- ============================================================================
