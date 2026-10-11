-- ============================================================================
-- Подготовка к кабинету подрядчика: переписывание прав доступа.
--
-- ЭТО НАДО СДЕЛАТЬ ДО ВЫДАЧИ ПЕРВОГО ДОСТУПА, А НЕ ПОСЛЕ. Сейчас в базе
-- действует правило, написанное в июле, когда в приложении были только свои:
--
--     create policy "authenticated_select" on <таблица>
--       for select using (auth.uid() is not null)
--
-- То есть «видит любой, кто вообще залогинился». Пока логины были только у
-- сотрудников, это работало. В момент, когда появится логин подрядчика, это
-- правило отдаст ему всё: расходы по остальным подрядчикам, выручку, разбор
-- по менеджерам, Автоправо, Аварком — тридцать шесть таблиц целиком. Причём
-- через приложение он этого не увидит, а через обычный HTTP-запрос к той же
-- базе (ключ лежит в коде страницы, он публичный по устройству Supabase) —
-- увидит всё. Поэтому доступ переписывается ДО создания учётных записей.
--
-- ЧТО ЗДЕСЬ ДЕЛАЕТСЯ:
--   1. Появляется третья роль — contractor. Отличие от viewer принципиальное:
--      viewer видит всё и ничего не меняет, contractor не видит НИЧЕГО из
--      базовых таблиц.
--   2. Политика authenticated_select заменяется на staff_select — «видит
--      сотрудник», то есть admin или viewer. Замена идёт перебором по
--      системному каталогу, а не по списку таблиц: список руками уже один раз
--      разъехался с реальностью (таблицы БФЛ и Автоправо добавлялись позже и
--      своими миграциями), и повторять эту ошибку незачем.
--   3. Закрывается отдельная дыра — weekly_stats. Это ЕДИНСТВЕННАЯ вьюха из
--      семидесяти двух, созданная без security_invoker, то есть работающая с
--      правами владельца и игнорирующая RLS в принципе. Через неё читаются
--      лиды, квалы, встречи, сделки, РАСХОД и ВЫРУЧКА по всем подрядчикам
--      сразу, и читает её весь дашборд. Без этой строки все остальные запреты
--      бессмысленны: закрыли дверь, оставили окно.
--   4. Заводится portal_security_audit — вьюха, которой в любой момент можно
--      проверить, не появилось ли новых дыр. Нужна потому, что вьюху или
--      таблицу легко создать мышкой в дашборде Supabase, минуя миграции, и
--      тогда она приедет с правами по умолчанию.
--
-- ЧЕГО ЗДЕСЬ НЕТ. Политик для роли contractor нет ни одной — ни на одной
-- базовой таблице. Это сделано намеренно: подрядчик получает доступ только к
-- нескольким вьюхам portal_*, каждая из которых сама фильтрует по своему
-- подрядчику (следующая миграция). Так проверка безопасности сводится к
-- одному вопросу — «что отдают пять вьюх portal_*» — вместо обхода тридцати
-- шести таблиц с рассуждением, какие колонки в каждой из них чувствительные.
-- ============================================================================

-- --- Роль и привязка к подрядчику -------------------------------------------
-- Старое ограничение снимается перебором по каталогу, а не по имени: имя у
-- него автоматическое (profiles_role_check), но полагаться на это нельзя —
-- если оно окажется другим, новая проверка не встанет, и миграция упадёт
-- посередине.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'profiles'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%role%'
  loop
    execute format('alter table profiles drop constraint %I', c.conname);
  end loop;
end $$;

alter table profiles add constraint profiles_role_check
  check (role in ('admin', 'viewer', 'contractor'));

alter table profiles
  add column if not exists contractor_id uuid references contractors(id) on delete cascade,
  -- Срок действия пароля и признак «пароль просрочен» — для ежемесячной
  -- смены. Заполняются миграцией ротации, здесь только объявлены, чтобы
  -- current_contractor_id ниже мог на них опираться.
  add column if not exists must_change_password boolean not null default false,
  add column if not exists password_rotated_at timestamptz,
  add column if not exists password_expires_at timestamptz;

-- Несогласованное состояние — роль contractor без подрядчика (увидит пустой
-- кабинет и будет звонить) или подрядчик у сотрудника (бессмысленно).
alter table profiles drop constraint if exists profiles_contractor_link_check;
alter table profiles add constraint profiles_contractor_link_check check (
  (role = 'contractor' and contractor_id is not null)
  or (role <> 'contractor' and contractor_id is null)
);

create index if not exists profiles_contractor_idx on profiles(contractor_id)
  where contractor_id is not null;

comment on column profiles.contractor_id is
  'Для роли contractor — какого подрядчика кабинет. Проверяется в '
  'current_contractor_id(); подменить со стороны клиента нельзя, потому что '
  'запись в profiles разрешена только админу.';

-- --- Кто такой сотрудник ----------------------------------------------------
-- security definer — чтобы функция работала внутри политик других таблиц
-- независимо от прав вызывающего на саму profiles, ровно как is_admin().
create or replace function is_staff()
returns boolean
language sql
security definer
set search_path = public
stable
as $$
  select exists (
    select 1 from profiles
    where id = auth.uid() and role in ('admin', 'viewer')
  );
$$;

comment on function is_staff() is
  'Залогинен сотрудник (admin или viewer). Роль contractor сюда НЕ входит — '
  'в этом весь смысл функции.';

-- --- Какого подрядчика кабинет открыт ---------------------------------------
-- Единственная точка, через которую определяется «чьи это данные». Все вьюхи
-- portal_* фильтруют по ней, поэтому все проверки доступа сосредоточены в
-- одном месте из восьми строк, которое можно прочитать целиком.
--
-- ВАЖНО: просроченный пароль обрывает доступ ЗДЕСЬ, на уровне базы, а не на
-- экране входа. Проверка в интерфейсе — это косметика: данные отдаёт база, и
-- запрос к ней можно послать мимо интерфейса.
--
-- Пустой срок означает «пароль ещё не выдавали», и доступа при нём нет —
-- иначе заведённый, но не выданный кабинет открылся бы сам по себе. Срок
-- ставит выдача пароля, см. миграцию 20261006_portal_3_password_issue.
create or replace function current_contractor_id()
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select p.contractor_id
  from profiles p
  where p.id = auth.uid()
    and p.role = 'contractor'
    and p.contractor_id is not null
    and p.must_change_password = false
    and p.password_expires_at is not null
    and p.password_expires_at > now();
$$;

comment on function current_contractor_id() is
  'Подрядчик текущего пользователя, либо NULL. NULL у всех, кроме роли '
  'contractor с действующим паролем — поэтому сравнение с ней никогда не '
  'пропустит ни сотрудника, ни анонима.';

-- --- Сотрудник вместо «любого залогиненного» --------------------------------
-- Перебор идёт по pg_policies, а не по списку таблиц: так переписываются и те
-- таблицы, что добавились после июля своими миграциями, и те, что кто-нибудь
-- создаст мышкой в дашборде по образцу старых.
do $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select schemaname, tablename
    from pg_policies
    where schemaname = 'public' and policyname = 'authenticated_select'
  loop
    execute format('drop policy "authenticated_select" on %I.%I', r.schemaname, r.tablename);
    -- На случай повторного прогона: политика с таким именем могла остаться с
    -- прошлого раза, и create упал бы на дубликате.
    execute format('drop policy if exists "staff_select" on %I.%I', r.schemaname, r.tablename);
    execute format(
      'create policy "staff_select" on %I.%I for select using (is_staff())',
      r.schemaname, r.tablename
    );
    n := n + 1;
  end loop;
  raise notice 'Переписано политик: %', n;
end $$;

-- Проверка, что голых политик не осталось. Намеренно NOTICE, а не EXCEPTION:
-- исключение откатило бы всю миграцию целиком, в том числе исправление
-- weekly_stats и создание проверочной вьюхи, — то есть из-за одной лишней
-- политики мы остались бы со всеми дырами сразу. Остатки видны в
-- portal_security_audit и красным на экране «Доступы подрядчиков».
do $$
declare leftovers text;
begin
  select string_agg(tablename, ', ')
  into leftovers
  from pg_policies
  where schemaname = 'public'
    and (policyname = 'authenticated_select' or qual = '(auth.uid() IS NOT NULL)');
  if leftovers is not null then
    raise notice 'ВНИМАНИЕ: остались политики «видит любой залогиненный»: %. '
      'Доступ подрядчику не выдавать, пока они есть.', leftovers;
  end if;
end $$;

-- --- profiles: админ управляет доступами ------------------------------------
-- Своё видит каждый (чтобы кабинет знал, чей он и не пора ли менять пароль),
-- все записи — только админ.
drop policy if exists "profiles_select_own" on profiles;
create policy "profiles_select_own" on profiles for select using (auth.uid() = id);

drop policy if exists "profiles_admin_all" on profiles;
create policy "profiles_admin_all" on profiles for all
  using (is_admin()) with check (is_admin());

-- ============================================================================
-- weekly_stats — закрытие главной дыры
--
-- Текст запроса не меняется ни на символ: исправляется только пропущенное
-- security_invoker. Без него вьюха читает daily_facts и weekly_expenses с
-- правами владельца, то есть RLS на этих таблицах для неё не существует.
-- Проверить разницу можно так: залогиниться подрядчиком и запросить
-- weekly_stats — до этой правки вернутся все подрядчики с расходом и
-- выручкой, после — ноль строк.
-- ============================================================================
-- Без cascade намеренно: если к вьюхе вдруг что-то прицепилось, пусть
-- миграция честно упадёт, а не снесёт это молча.
drop view if exists weekly_stats;
create view weekly_stats with (security_invoker = true) as
with facts_agg as (
  select
    contractor_id,
    fact_date - (extract(dow from fact_date)::integer + 3) % 7 as week_start,
    sum(leads) as leads,
    sum(quals) as quals,
    sum(meetings) as meetings,
    sum(deals) as deals,
    sum(coalesce(revenue, 0)) as revenue,
    sum(coalesce(duplicates, 0)) as duplicates
  from daily_facts
  where contractor_id is not null
  group by contractor_id, (fact_date - (extract(dow from fact_date)::integer + 3) % 7)
),
expenses_agg as (
  select contractor_id, week_start, sum(spend) as spend
  from weekly_expenses
  group by contractor_id, week_start
),
keys as (
  select contractor_id, week_start from facts_agg
  union
  select contractor_id, week_start from expenses_agg
)
select
  k.contractor_id,
  k.week_start,
  coalesce(f.leads, 0) as leads,
  coalesce(f.quals, 0) as quals,
  coalesce(f.meetings, 0) as meetings,
  coalesce(f.deals, 0) as deals,
  coalesce(e.spend, 0::numeric) as spend,
  coalesce(f.revenue, 0) as revenue,
  coalesce(f.duplicates, 0) as duplicates
from keys k
left join facts_agg f on f.contractor_id = k.contractor_id and f.week_start = k.week_start
left join expenses_agg e on e.contractor_id = k.contractor_id and e.week_start = k.week_start;

-- Пересоздание вьюхи сбрасывает выданные на неё права, поэтому выдаём заново
-- явно, а не надеемся на настройки по умолчанию.
grant select on weekly_stats to authenticated, service_role;
revoke all on weekly_stats from anon;

comment on view weekly_stats is
  'ВНИМАНИЕ: не пересоздавать без «with (security_invoker = true)». Без этой '
  'опции вьюха работает с правами владельца и отдаёт расход и выручку по всем '
  'подрядчикам любому залогиненному, включая подрядчиков.';

-- ============================================================================
-- Проверка прав — вьюха, а не разовый запрос
--
-- Таблицу или вьюху легко создать мышкой в дашборде Supabase, и тогда она
-- приедет с правами по умолчанию: вьюха — без security_invoker, таблица —
-- вообще без RLS. Через месяц никто не вспомнит, что это надо проверять,
-- поэтому проверка лежит в базе и смотрится одним select.
--
--   select * from portal_security_audit;
--
-- Пустой результат — всё в порядке. Непустой — читать колонку «что_делать».
-- ============================================================================
drop view if exists portal_security_audit;
create view portal_security_audit with (security_invoker = true) as
-- 1. Вьюхи без security_invoker: работают с правами владельца, RLS для них
--    не существует.
select
  'вьюха без security_invoker'::text as проблема,
  c.relname::text as объект,
  'пересоздать с «with (security_invoker = true)»'::text as что_делать
from pg_class c
where c.relkind = 'v'
  and c.relnamespace = 'public'::regnamespace
  and not coalesce(c.reloptions, '{}'::text[]) @> array['security_invoker=true']
  -- Вьюхи кабинета — единственное законное исключение: они обязаны читать
  -- таблицы, к которым у подрядчика доступа нет совсем, и фильтруют сами,
  -- внутри, по current_contractor_id(). См. миграцию portal_contractor_data.
  and c.relname not like 'portal_my_%'
  and c.relname not in ('portal_stage_guide', 'portal_source_owner')

union all

-- 2. Таблицы с выключенным RLS: читает кто угодно, включая анонимов с
--    публичным ключом из кода страницы.
select
  'таблица без RLS',
  c.relname::text,
  'alter table … enable row level security + политика staff_select'
from pg_class c
where c.relkind = 'r'
  and c.relnamespace = 'public'::regnamespace
  and not c.relrowsecurity

union all

-- 3. Политики «видит любой залогиненный»: ровно то, что эта миграция
--    вычищает. Появление новой означает, что кто-то скопировал старый
--    образец.
select
  'политика «видит любой залогиненный»',
  tablename::text,
  'заменить условие на is_staff()'
from pg_policies
where schemaname = 'public'
  and (policyname = 'authenticated_select' or qual = '(auth.uid() IS NOT NULL)')

union all

-- 4. Таблица с включённым RLS, но без единой политики: читать её не может
--    никто, кроме service_role. Это не дыра, а обратная поломка — экран
--    будет пустым без сообщения об ошибке.
select
  'RLS включён, политик нет',
  c.relname::text,
  'добавить политику staff_select, иначе экран будет пустым'
from pg_class c
where c.relkind = 'r'
  and c.relnamespace = 'public'::regnamespace
  and c.relrowsecurity
  and not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname
  );

comment on view portal_security_audit is
  'Проверка прав доступа. Пустой результат — всё закрыто правильно. '
  'Смотреть после каждой правки схемы, особенно сделанной через дашборд.';
