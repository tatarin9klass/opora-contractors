-- ============================================================================
-- Кабинет РОПа не видел собственных данных. Разбор и починка.
--
-- ЧТО ПРОИСХОДИЛО. Руслан заходил в кабинет и видел нули во всех плитках —
-- без единой ошибки на экране, потому что запросы отрабатывали успешно и
-- возвращали ноль строк.
--
-- ПОЧЕМУ. Вьюхи rop_portal_* намеренно сделаны без security_invoker: они
-- обязаны читать таблицы, к которым у роли rop доступа нет, и фильтруют
-- сами — ровно так же устроен кабинет подрядчика. Но читают они не таблицы,
-- а промежуточные витрины (rop_daily, rop_daily_manager, rop_stage_since), а
-- у тех security_invoker = true.
--
-- И вот что это меняет: для вьюхи с security_invoker база проверяет права не
-- владельца, а того, кто выполняет запрос. Цепочка «обёртка владельца →
-- витрина инвокера → таблица» на последнем шаге спрашивает права РОПа. На
-- rop_deals и rop_deal_stages стоит staff_select (is_staff()), роль rop в
-- сотрудники не входит — и строки отсекались ещё до того, как обёртка
-- успевала что-то отдать.
--
-- ПОЧЕМУ НЕ ПОЙМАЛОСЬ РАНЬШЕ. Проверял я под админским идентификатором: у
-- админа is_staff() истинна, цепочка проходит целиком, витрины отдавали 92 и
-- 180 строк. Поломка видна только под самим РОПом. Отсюда правило, которое
-- теперь записано внизу файла: любой новый кабинет проверяется входом под той
-- ролью, для которой он сделан, а не под админом.
--
-- ЧТО СДЕЛАНО. Промежуточные витрины переведены на права владельца и
-- отобраны у клиентских ролей. Первое чинит цепочку, второе закрывает дыру,
-- которую первое иначе бы открыло: вьюха с правами владельца, доступная
-- authenticated, отдала бы показатели отдела любому залогиненному, включая
-- подрядчиков. Теперь их не может прочитать никто, кроме самих обёрток
-- rop_portal_*, а те спрашивают rop_can_read().
--
-- ПОЧЕМУ НЕ ПОЛИТИКА ДЛЯ РОЛИ rop НА ТАБЛИЦАХ. Это был бы второй очевидный
-- способ, и он хуже: политика на rop_deals отдала бы РОПу все сделки
-- воронки, включая чужой отдел, — то самое, ради чего витрины и фильтруются
-- по составу отдела. Права остаются там, где их видно целиком: в пяти
-- вьюхах rop_portal_*.
-- ============================================================================

do $$
declare v text;
begin
  foreach v in array array[
    'rop_deal_money', 'rop_events', 'rop_daily', 'rop_daily_manager', 'rop_stage_since'
  ] loop
    if to_regclass('public.' || v) is null then
      raise notice 'нет вьюхи %, пропускаю', v;
      continue;
    end if;
    -- Права владельца: цепочка обёрток перестаёт упираться в RLS того, кто
    -- спрашивает.
    execute format('alter view %I set (security_invoker = false)', v);
    -- И сразу же — прочь от клиентов. Порядок важен: между двумя командами
    -- вьюха на мгновение становится открытой, и оставлять это состояние
    -- надолго нельзя.
    execute format('revoke all on %I from anon, authenticated', v);
  end loop;
end $$;

comment on view rop_daily is
  'Внутренняя витрина. Клиентам не выдаётся: читается только обёртками '
  'rop_portal_*, которые проверяют доступ через rop_can_read().';

comment on view rop_daily_manager is
  'Внутренняя витрина. Клиентам не выдаётся — см. комментарий к rop_daily.';

comment on view rop_events is
  'Внутренняя витрина. Клиентам не выдаётся — см. комментарий к rop_daily.';

-- ============================================================================
-- Аудит учится отличать опасное от безобидного
--
-- Правило «вьюха без security_invoker» раньше срабатывало на любую такую
-- вьюху, и список исключений пришлось бы дописывать при каждом новом
-- кабинете. Опасна же не сама по себе вьюха с правами владельца, а такая,
-- которую может прочитать клиент: anon или authenticated. Витрину, отобранную
-- у обеих ролей, не прочитает никто, кроме обёрток, — ей RLS и не нужен.
--
-- Исключения остаются только для вьюх, которые выданы клиентам НАМЕРЕННО и
-- фильтруют внутри себя: кабинет подрядчика и кабинет РОПа. Их пять и пять,
-- и каждую можно прочитать глазами целиком.
-- ============================================================================
drop view if exists portal_security_audit;
create view portal_security_audit with (security_invoker = true) as
select
  'вьюха без security_invoker, доступная клиенту'::text as проблема,
  c.relname::text as объект,
  'либо пересоздать с «with (security_invoker = true)», либо отобрать '
  'права у anon и authenticated'::text as что_делать
from pg_class c
where c.relkind = 'v'
  and c.relnamespace = 'public'::regnamespace
  and not coalesce(c.reloptions, '{}'::text[]) @> array['security_invoker=true']
  -- Клиент её видит — значит, это вопрос безопасности, а не внутренняя кухня.
  and (has_table_privilege('anon', c.oid, 'select')
       or has_table_privilege('authenticated', c.oid, 'select'))
  -- Кабинеты: читают таблицы, закрытые для их роли, и фильтруют внутри —
  -- подрядчик по current_contractor_id(), РОП по rop_can_read() и составу
  -- отдела. Это и есть способ, которым кабинеты устроены.
  and c.relname not like 'portal_my_%'
  and c.relname not like 'rop_portal_%'
  and c.relname not in ('portal_stage_guide', 'portal_source_owner')

union all

select
  'таблица без RLS',
  c.relname::text,
  'alter table … enable row level security + политика staff_select'
from pg_class c
where c.relkind = 'r'
  and c.relnamespace = 'public'::regnamespace
  and not c.relrowsecurity

union all

select
  'политика «видит любой залогиненный»',
  tablename::text,
  'заменить условие на is_staff()'
from pg_policies
where schemaname = 'public'
  and (policyname = 'authenticated_select' or qual = '(auth.uid() IS NOT NULL)')

union all

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

-- ============================================================================
-- Проверка — под той ролью, для которой кабинет сделан
--
-- Подставляет JWT конкретного человека и спрашивает базу ровно то, что
-- спрашивает приложение. Почту заменить на нужную.
--
--   begin;
--   select set_config('request.jwt.claims',
--     json_build_object(
--       'sub',  (select id::text from auth.users where email = 'ПОЧТА'),
--       'role', 'authenticated')::text, true);
--   set local role authenticated;
--   select
--     rop_can_read()                             as доступ_открыт,
--     (select count(*) from rop_portal_daily)    as дашборд,
--     (select count(*) from rop_portal_manager)  as менеджеры,
--     (select count(*) from rop_portal_managers) as состав_отдела;
--   rollback;
--
-- Под почтой РОПа все четыре колонки должны быть непустыми. Под почтой
-- подрядчика — доступ_открыт false и нули во всех остальных: это не поломка,
-- а ровно то, чего мы добиваемся.
-- ============================================================================
