-- ============================================================================
-- Закрытие объектов, заведённых мимо миграций.
--
-- ОТКУДА ОНИ ВЗЯЛИСЬ. Проверка прав, появившаяся в первой миграции, нашла
-- то, ради чего и писалась: таблицы и вьюхи, созданные в дашборде Supabase
-- в обход миграций. Они приехали с правами по умолчанию — таблица без RLS
-- читается кем угодно, вьюха без security_invoker работает с правами
-- владельца и RLS для неё не существует. Среди найденного, например,
-- invoices, monthly_plans и change_log.
--
-- Пока логины были только у своих, это не имело последствий. С появлением
-- логина подрядчика любая такая таблица открыта ему целиком — не через
-- приложение, а обычным запросом к базе.
--
-- ПЕРЕБОРОМ ПО КАТАЛОГУ, А НЕ ПО СПИСКУ. Список я взял бы с экрана, а он
-- прокручивается, и часть строк в него не поместилась. Перебор закрывает всё,
-- что подходит под условие, сколько бы его ни было, и повторный прогон этой
-- миграции безопасен: уже закрытое он пропускает.
--
-- ВЬЮХИ ПРАВЯТСЯ БЕЗ ПЕРЕСОЗДАНИЯ. alter view … set (security_invoker = true)
-- меняет только режим доступа и не трогает текст запроса. Это важно: часть
-- этих вьюх написана не мной и не лежит в миграциях — пересоздавать их
-- значило бы сначала вытащить определение из базы и понадеяться, что я его
-- нигде не исказил.
--
-- ЧЕГО ОЖИДАТЬ ПОСЛЕ ПРОГОНА. Если какой-то экран приложения вдруг опустеет,
-- причина будет одна: вьюха читает таблицу, у которой теперь есть RLS, но
-- политики нет. Лечится добавлением staff_select на эту таблицу, и такие
-- случаи сама же проверка и покажет строкой «RLS включён, политик нет».
-- Сотрудники (admin и viewer) после этой миграции видят ровно то же, что и
-- до неё.
-- ============================================================================

-- --- Таблицы без RLS --------------------------------------------------------
-- Те же две политики, что и у остальных таблиц приложения: читает сотрудник,
-- пишет админ. Импорт из Битрикса работает через служебный ключ, которому RLS
-- не писан, — его это не касается.
do $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select c.relname
    from pg_class c
    where c.relkind = 'r'
      and c.relnamespace = 'public'::regnamespace
      and not c.relrowsecurity
      -- Таблицы, принадлежащие расширениям, не наши: у них своя логика
      -- доступа, и трогать их незачем.
      and not exists (
        select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e'
      )
    order by c.relname
  loop
    execute format('alter table %I enable row level security', r.relname);
    execute format('drop policy if exists "staff_select" on %I', r.relname);
    execute format(
      'create policy "staff_select" on %I for select using (is_staff())', r.relname);
    execute format('drop policy if exists "admin_write" on %I', r.relname);
    execute format(
      'create policy "admin_write" on %I for all using (is_admin()) with check (is_admin())',
      r.relname);
    n := n + 1;
    raise notice 'Закрыта таблица: %', r.relname;
  end loop;
  raise notice 'Всего таблиц закрыто: %', n;
end $$;

-- --- Вьюхи без security_invoker ---------------------------------------------
-- Вьюхи кабинета пропускаются: для них отсутствие security_invoker —
-- единственный законный случай. Они обязаны читать таблицы, к которым у
-- подрядчика доступа нет совсем, и фильтруют сами, внутри, по
-- current_contractor_id().
do $$
declare
  r record;
  n integer := 0;
begin
  for r in
    select c.relname
    from pg_class c
    where c.relkind = 'v'
      and c.relnamespace = 'public'::regnamespace
      and not coalesce(c.reloptions, '{}'::text[]) @> array['security_invoker=true']
      and c.relname not like 'portal_my_%'
      and c.relname not in ('portal_stage_guide', 'portal_source_owner')
      and not exists (
        select 1 from pg_depend d where d.objid = c.oid and d.deptype = 'e'
      )
    order by c.relname
  loop
    execute format('alter view %I set (security_invoker = true)', r.relname);
    n := n + 1;
    raise notice 'Исправлена вьюха: %', r.relname;
  end loop;
  raise notice 'Всего вьюх исправлено: %', n;
end $$;

-- --- Что осталось -----------------------------------------------------------
-- Остаться может только «RLS включён, политик нет» — например, если такая
-- таблица была заведена руками до этой миграции и политику ей так и не
-- добавили. Печатаем, а не падаем: падение откатило бы всё закрытое выше.
do $$
declare leftovers text;
begin
  select string_agg(объект, ', ') into leftovers from portal_security_audit;
  if leftovers is null then
    raise notice 'Проверка прав пуста — всё закрыто.';
  else
    raise notice 'Осталось разобрать: %', leftovers;
  end if;
end $$;
