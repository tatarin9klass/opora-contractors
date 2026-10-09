-- ============================================================================
-- Ежемесячная смена пароля подрядчика.
--
-- ЧТО ИМЕННО СДЕЛАНО. Раз в месяц пароль подрядчика объявляется просроченным.
-- При следующем входе кабинет не отдаёт ни одной цифры, пока человек не
-- задаст новый пароль. Новый пароль он придумывает сам — мы его не видим и не
-- храним.
--
-- ПОЧЕМУ НЕ «СИСТЕМА САМА ГЕНЕРИРУЕТ И ПРИСЫЛАЕТ». Чтобы прислать
-- сгенерированный пароль, нужен канал доставки — почта с настроенным SMTP или
-- мессенджер. Его нет, и появись он, пароль пришлось бы передавать по этому
-- каналу в открытом виде и где-то хранить до передачи. Принудительная смена
-- силами самого подрядчика даёт тот же результат — пароль месячной давности
-- не работает, — и при этом мы не знаем ни одного действующего пароля.
--
-- ЗАПРЕТ ДЕЙСТВУЕТ В БАЗЕ, А НЕ НА ЭКРАНЕ. Просроченный пароль обрывает
-- доступ внутри current_contractor_id(), то есть внутри самих вьюх кабинета.
-- Проверка в интерфейсе — это удобство: запрос к базе можно послать и мимо
-- интерфейса, публичный ключ лежит в коде страницы. Поэтому открытая вкладка
-- с живым токеном после ротации тоже перестаёт что-либо отдавать.
--
-- СОТРУДНИКОВ НЕ КАСАЕТСЯ. Роли admin и viewer работают как раньше.
-- Заставлять владельца менять пароль каждый месяц никто не просил, а ломать
-- себе вход — худший способ начать.
--
-- ОТДЕЛЬНО: ПЕРВЫЙ ВХОД. Новая учётная запись подрядчика создаётся с уже
-- поднятым флагом «сменить пароль». Выданный вручную временный пароль
-- перестаёт работать сразу после первого входа, и дальше действующего пароля
-- не знает никто, кроме самого подрядчика. Это не побочный эффект, а главный
-- смысл всей конструкции.
--
-- ============================================================================
-- КАК ПРОВЕРЯЕТСЯ, ЧТО ПАРОЛЬ ДЕЙСТВИТЕЛЬНО СМЕНИЛИ
--
-- Напрашивается триггер на auth.users: пароль изменился — флаг снят. От него
-- я отказался сознательно. Таблица auth.users принадлежит GoTrue
-- (supabase_auth_admin), а не нам; право навесить на неё триггер у роли
-- postgres сегодня есть, но это чужая таблица, и её владелец вправе поменять
-- правила при очередном обновлении. Молча отвалившийся триггер здесь означал
-- бы, что подрядчик навсегда заперт на экране смены пароля.
--
-- Вместо триггера — отпечаток: md5 от того, что GoTrue хранит в
-- encrypted_password. При ротации отпечаток запоминается, после смены пароля
-- кабинет вызывает portal_confirm_password_change(), и та снимает флаг ТОЛЬКО
-- если отпечаток в самом деле стал другим. Подделать это из браузера нельзя:
-- сравнение происходит внутри security definer функции, а вызвать её с чужим
-- результатом невозможно — она смотрит на auth.uid() вызывающего.
--
-- ОТПЕЧАТОК ЛЕЖИТ В ОТДЕЛЬНОЙ ТАБЛИЦЕ, А НЕ В profiles. Свою строку в
-- profiles пользователь читать вправе — она ему нужна, чтобы узнать роль. Это
-- значит, что любое поле в profiles подрядчик может прочитать, а md5 от
-- bcrypt-хеша своего пароля отдавать ему незачем: пользы ноль, а это материал
-- для подбора вне нашей системы. Поэтому отпечаток живёт в таблице с RLS без
-- единой разрешающей политики — её не читает никто, кроме функций ниже.
-- ============================================================================

create table if not exists contractor_password_state (
  profile_id uuid primary key references profiles(id) on delete cascade,
  fingerprint text,
  updated_at timestamptz not null default now()
);

alter table contractor_password_state enable row level security;
-- Политик нет намеренно. RLS включён, разрешающих правил ни одного — значит
-- таблицу не читает ни один пользователь, включая админа. Работают с ней
-- только security definer функции этой миграции и service_role.
comment on table contractor_password_state is
  'Отпечаток пароля (md5 от encrypted_password) для проверки факта смены. '
  'Читается только функциями portal_confirm_password_change и '
  'rotate_contractor_passwords. Политик нет СПЕЦИАЛЬНО — не добавлять.';

-- Текущий отпечаток пароля из GoTrue. Отдельной функцией, чтобы чтение чужой
-- таблицы auth.users было в одном месте, а не разбросано по трём.
create or replace function auth_password_fingerprint(uid uuid)
returns text
language sql
security definer
set search_path = public
stable
as $$
  select md5(coalesce(u.encrypted_password, '')) from auth.users u where u.id = uid;
$$;

-- Отзыв именно у PUBLIC: право выполнять функцию по умолчанию выдаётся
-- именно этой роли, и отзыв у anon с authenticated ничего бы не дал — они
-- получают его через PUBLIC. Эту функцию не должен вызывать никто: она нужна
-- только двум функциям ниже, а они security definer и работают с правами
-- владельца.
revoke all on function auth_password_fingerprint(uuid) from public;

-- --- Новая учётная запись подрядчика: пароль сменить при первом входе -------
create or replace function on_profile_contractor_created()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role = 'contractor' and new.password_rotated_at is null then
    new.must_change_password := true;
  end if;
  return new;
end $$;

drop trigger if exists trg_profile_contractor_created on profiles;
create trigger trg_profile_contractor_created
  before insert on profiles
  for each row execute function on_profile_contractor_created();

-- Отпечаток временного пароля запоминается после вставки — к этому моменту
-- строка в profiles уже есть, и внешний ключ не нарушается.
create or replace function on_profile_contractor_created_after()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.role = 'contractor' then
    insert into contractor_password_state (profile_id, fingerprint)
    values (new.id, auth_password_fingerprint(new.id))
    on conflict (profile_id) do update set
      fingerprint = excluded.fingerprint, updated_at = now();
  end if;
  return new;
end $$;

drop trigger if exists trg_profile_contractor_created_after on profiles;
create trigger trg_profile_contractor_created_after
  after insert on profiles
  for each row execute function on_profile_contractor_created_after();

-- ============================================================================
-- Подтверждение смены пароля — вызывается кабинетом после updateUser
--
-- Возвращает true, если пароль действительно сменился и доступ открыт.
-- Поднимает исключение, если пароль тот же: кабинет покажет это сообщение
-- вместо молчаливого возврата на тот же экран.
-- ============================================================================
create or replace function portal_confirm_password_change()
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare
  uid uuid := auth.uid();
  prof profiles;
  now_fp text;
  old_fp text;
begin
  if uid is null then
    raise exception 'Нужен вход в кабинет';
  end if;

  select * into prof from profiles where id = uid;
  if not found then
    raise exception 'Доступ не настроен';
  end if;

  now_fp := auth_password_fingerprint(uid);
  select fingerprint into old_fp from contractor_password_state where profile_id = uid;

  -- Отпечатка нет вовсе — учётная запись заведена до этой миграции. Считаем
  -- первую смену состоявшейся: иначе человек останется заперт навсегда.
  if old_fp is not null and now_fp is not distinct from old_fp then
    raise exception 'Пароль не изменился — задайте новый, отличный от прежнего';
  end if;

  update profiles set
    must_change_password = false,
    password_rotated_at = now(),
    password_expires_at = case
      when role = 'contractor' then now() + interval '1 month'
      else null
    end
  where id = uid;

  insert into contractor_password_state (profile_id, fingerprint)
  values (uid, now_fp)
  on conflict (profile_id) do update set
    fingerprint = excluded.fingerprint, updated_at = now();

  return true;
end $$;

-- Сначала отзыв у PUBLIC, потом выдача ровно тем, кому надо. Обратный
-- порядок оставил бы право у анонимов.
revoke all on function portal_confirm_password_change() from public;
grant execute on function portal_confirm_password_change() to authenticated;

comment on function portal_confirm_password_change() is
  'Снимает флаг «сменить пароль», но только если пароль в самом деле стал '
  'другим. Вызывается кабинетом сразу после supabase.auth.updateUser.';

-- ============================================================================
-- Сама ротация
--
-- Идемпотентна: берёт только тех, у кого пароль реально старше месяца.
-- Случайный повторный запуск не выбьет из кабинета того, кто сменил пароль
-- вчера.
-- ============================================================================
create or replace function rotate_contractor_passwords()
returns integer
language plpgsql
security definer
set search_path = public
as $$
declare
  ids uuid[];
  uid uuid;
begin
  select coalesce(array_agg(id), '{}')
  into ids
  from profiles
  where role = 'contractor'
    and must_change_password = false
    and coalesce(password_rotated_at, '-infinity'::timestamptz) < now() - interval '1 month';

  if array_length(ids, 1) is null then
    return 0;
  end if;

  update profiles set
    must_change_password = true,
    password_expires_at = now()
  where id = any(ids);

  -- Отпечаток текущего пароля — чтобы потом было с чем сравнить. Без этого
  -- шага подрядчик смог бы «сменить» пароль на тот же самый.
  foreach uid in array ids loop
    insert into contractor_password_state (profile_id, fingerprint)
    values (uid, auth_password_fingerprint(uid))
    on conflict (profile_id) do update set
      fingerprint = excluded.fingerprint, updated_at = now();
  end loop;

  -- Сброс открытых сессий: без него вкладка, оставленная открытой, доживёт до
  -- конца срока токена. Данных она и так не получит (их обрывает
  -- current_contractor_id), но человек увидит пустой кабинет без объяснения,
  -- а должен увидеть экран смены пароля.
  --
  -- Обёрнуто в обработчик намеренно: внутренняя схема auth принадлежит
  -- GoTrue и может измениться с его обновлением. Если сессии вычистить не
  -- удалось — ротация всё равно состоялась, это главное.
  begin
    delete from auth.refresh_tokens
    where user_id in (select u::text from unnest(ids) as u);
    delete from auth.sessions where user_id = any(ids);
  exception when others then
    raise notice 'Сессии не сброшены (%). Доступ всё равно закрыт на уровне данных.', sqlerrm;
  end;

  return array_length(ids, 1);
end $$;

-- Запускают только планировщик и админ через SQL — пользователям не нужна.
revoke all on function rotate_contractor_passwords() from public;

comment on function rotate_contractor_passwords() is
  'Объявляет просроченными пароли подрядчиков старше месяца. Возвращает число '
  'затронутых учётных записей. Безопасна для ручного запуска: тех, кто сменил '
  'пароль недавно, не трогает.';

-- ============================================================================
-- Расписание
--
-- Первое число каждого месяца, 01:12 UTC (04:12 по Москве) — ночью, чтобы
-- подрядчик не оказался выброшен из кабинета посреди рабочего разбора. Минута
-- не круглая намеренно: в ноль минут запускается всё на свете.
--
-- pg_cron в Supabase включается галочкой (Database → Extensions → pg_cron).
-- Если расширения нет, миграция не падает, а печатает, что делать: ротация
-- остаётся рабочей, её можно вызывать руками или внешним планировщиком.
-- ============================================================================
do $$
begin
  if not exists (select 1 from pg_extension where extname = 'pg_cron') then
    raise notice 'pg_cron не включён — расписание не создано. Включи его в '
      'Database → Extensions, затем выполни блок из комментария ниже. '
      'До этого вызывай rotate_contractor_passwords() вручную.';
    return;
  end if;

  perform cron.unschedule('rotate_contractor_passwords')
  where exists (select 1 from cron.job where jobname = 'rotate_contractor_passwords');

  perform cron.schedule(
    'rotate_contractor_passwords',
    '12 1 1 * *',
    'select rotate_contractor_passwords()'
  );
  raise notice 'Расписание создано: первое число месяца, 01:12 UTC.';
end $$;

-- Если pg_cron включали после этой миграции — выполнить вручную:
--
--   select cron.schedule('rotate_contractor_passwords', '12 1 1 * *',
--                        'select rotate_contractor_passwords()');

-- ============================================================================
-- Что видит админ про доступы
--
-- Нужна для разговора «почему подрядчик не может зайти»: в одной строке
-- видно, просрочен пароль, не менялся ли он ни разу и когда истекает.
-- ============================================================================
drop view if exists contractor_access_status;
create view contractor_access_status with (security_invoker = true) as
select
  c.name as подрядчик,
  p.email,
  case
    when p.must_change_password and p.password_rotated_at is null then 'не входил ни разу'
    when p.must_change_password then 'пароль просрочен, нужна смена'
    else 'доступ действует'
  end as состояние,
  p.password_rotated_at as пароль_сменён,
  p.password_expires_at as действует_до,
  greatest(0, extract(day from p.password_expires_at - now())::integer) as дней_осталось
from profiles p
join contractors c on c.id = p.contractor_id
where p.role = 'contractor';

comment on view contractor_access_status is
  'Состояние доступов подрядчиков. Читает админ (RLS на profiles). '
  'Действующих паролей тут нет и быть не может — мы их не храним.';

-- ============================================================================
-- Как выдать доступ подрядчику — по шагам
--
-- 1. Supabase Dashboard → Authentication → Users → Add user.
--    Email подрядчика, временный пароль придумать любой — он проживёт один
--    вход. «Auto confirm user» включить, иначе человек будет ждать письма с
--    подтверждением, которого некому отправить.
--
-- 2. Привязать к подрядчику (подставить email и точное название из
--    справочника подрядчиков):
--
--    insert into profiles (id, email, role, contractor_id)
--    select u.id, u.email, 'contractor', c.id
--    from auth.users u, contractors c
--    where u.email = 'ПОЧТА_ПОДРЯДЧИКА'
--      and c.name = 'НАЗВАНИЕ_ПОДРЯДЧИКА'
--    on conflict (id) do update set
--      role = 'contractor', contractor_id = excluded.contractor_id;
--
--    ВНИМАНИЕ: если строка уже была (например заводили как viewer), ветка
--    on conflict не поднимет флаг смены пароля — его ставит триггер на
--    вставку. В таком случае после привязки выполнить:
--
--    update profiles set must_change_password = true, password_rotated_at = null
--    where email = 'ПОЧТА_ПОДРЯДЧИКА';
--
-- 3. Проверить, что кабинет не покажет лишнего и не потеряет своего
--    (всё это видно на экране «Доступы подрядчиков»):
--
--    select * from portal_security_audit;      -- пусто
--    select * from portal_source_conflicts;    -- пусто
--    select * from contractor_access_status;   -- «не входил ни разу»
--
-- 4. Передать подрядчику ссылку и временный пароль. При первом входе он
--    обязан задать свой — временный после этого не работает.
--
-- ОТОЗВАТЬ ДОСТУП: delete from profiles where email = '…'; и удалить
-- пользователя в Dashboard. Одного удаления профиля достаточно, чтобы
-- кабинет опустел (без строки в profiles роли нет), но учётную запись лучше
-- убрать тоже — чтобы не копились входы без прав.
-- ============================================================================
