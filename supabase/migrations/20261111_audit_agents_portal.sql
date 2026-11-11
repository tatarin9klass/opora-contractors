-- ============================================================================
-- Аудит прав узнаёт витрины кабинета агентской сети.
--
-- ЧТО ПРОИЗОШЛО. Аудит пометил шесть витрин agents_portal_* как «вьюха без
-- security_invoker, доступная клиенту». Это не дыра, а пробел в самом
-- аудите: он перечисляет законные кабинетные витрины по именам, и когда
-- появился кабинет агентов, список не обновили.
--
-- ПОЧЕМУ ЭТИ ВИТРИНЫ ОБЯЗАНЫ БЫТЬ DEFINER. Роль agentlead не имеет прав ни
-- на одной базовой таблице — это и есть защита. Витрина читает закрытые
-- таблицы правами владельца и сама решает, что отдать, проверяя
-- agents_can_read(). Сделай её invoker — и кабинет вернёт пустоту, потому
-- что у роли нет доступа к тому, из чего он собран. Ровно та же история
-- была с кабинетом РОПа, разобрана в 20261019_rop_portal_chain.sql.
--
-- ЧЕГО СТОИТ ИСКЛЮЧЕНИЕ ПО ИМЕНИ. Любая будущая витрина, названная
-- agents_portal_*, попадёт под него автоматически — в том числе
-- ошибочная, без проверки роли внутри. Это сознательная плата за то,
-- чтобы аудит не кричал на нормальное устройство кабинетов. Обязательство
-- простое: витрина с таким именем ВСЕГДА начинается с «where
-- agents_can_read()». Проверка этого — в конце файла.
-- ============================================================================
create or replace view portal_security_audit with (security_invoker = true) as
select
  'вьюха без security_invoker, доступная клиенту'::text as проблема,
  c.relname::text as объект,
  'либо пересоздать с «with (security_invoker = true)», либо отобрать '
  'права у anon и authenticated'::text as что_делать
from pg_class c
where c.relkind = 'v'
  and c.relnamespace = 'public'::regnamespace
  and not coalesce(c.reloptions, '{}'::text[]) @> array['security_invoker=true']
  and (has_table_privilege('anon', c.oid, 'select')
       or has_table_privilege('authenticated', c.oid, 'select'))
  -- Кабинеты: читают таблицы, закрытые для их роли, и фильтруют внутри —
  -- подрядчик по current_contractor_id(), РОП по rop_can_read() и составу
  -- отдела, руководитель агентской сети по agents_can_read(). Это и есть
  -- способ, которым кабинеты устроены.
  and c.relname not like 'portal_my_%'
  and c.relname not like 'rop_portal_%'
  and c.relname not like 'agents_portal_%'
  and c.relname not in ('portal_stage_guide', 'portal_source_owner', 'portal_freshness')

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
  'добавить политику staff_select или admin_write'
from pg_class c
where c.relkind = 'r'
  and c.relnamespace = 'public'::regnamespace
  and c.relrowsecurity
  and not exists (
    select 1 from pg_policies p
    where p.schemaname = 'public' and p.tablename = c.relname
  );

-- ============================================================================
-- ПРОВЕРКА, КОТОРАЯ И ОПРАВДЫВАЕТ ИСКЛЮЧЕНИЕ.
--
-- Каждая витрина agents_portal_* обязана проверять роль внутри себя.
-- Запрос возвращает те, в определении которых нет agents_can_read(), —
-- пустой результат означает, что исключение по имени безопасно.
--
-- select c.relname as витрина_без_проверки_роли
-- from pg_class c
-- where c.relkind = 'v'
--   and c.relnamespace = 'public'::regnamespace
--   and c.relname like 'agents_portal_%'
--   and pg_get_viewdef(c.oid) not like '%agents_can_read()%';
--
-- И сам аудит — после миграции он должен быть пустым:
--
-- select * from portal_security_audit;
-- ============================================================================
