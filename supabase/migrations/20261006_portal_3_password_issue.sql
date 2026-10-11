-- ============================================================================
-- Пароли подрядчиков: выдаёт руководитель, срок — месяц.
--
-- ЧТО ИМЕННО ПРОИСХОДИТ. Пароль генерирует система, показывает его один раз
-- на экране «Доступы подрядчиков» — руководитель копирует и передаёт
-- подрядчику. Через месяц пароль перестаёт работать сам, и кабинет требует
-- выдать новый. Подрядчик пароль не меняет и менять не может: это выданный
-- доступ, а не его личная учётная запись.
--
-- СРОК — ЭТО ПРОСТО ДАТА, А НЕ ЗАДАНИЕ В ПЛАНИРОВЩИКЕ. Доступ обрывается
-- сравнением password_expires_at с текущим моментом внутри
-- current_contractor_id(), то есть внутри самих вьюх кабинета. Отсюда два
-- следствия, оба полезных:
--   * ничего не может «не сработать» — нет задания, которое падает молча;
--   * просрочка наступает ровно в свою минуту, даже если в этот момент у
--     подрядчика открыта вкладка с живым токеном. Данных она не получит.
-- Поэтому pg_cron тут не нужен вообще, и предыдущая версия этой миграции с
-- расписанием ниже отменяется.
--
-- ПАРОЛЬ НЕ ХРАНИТСЯ НИГДЕ. Он показывается один раз в ответе функции выдачи
-- и в базу не пишется. Это не перестраховка: таблица с паролями в открытом
-- виде попадает в резервные копии, в выгрузки и в руки любому, кто получил
-- доступ к базе, — а пользы от хранения нет, потому что потерянный пароль
-- проще выдать заново одной кнопкой. Если пароль потерялся — выдать новый.
--
-- ЧТО ЗНАЧИТ «ВЫДАЁТ ТОЛЬКО РУКОВОДИТЕЛЬ». Сменить пароль пользователю может
-- только служебный ключ Supabase, а он лежит в Edge Function portal-access и
-- в браузер не попадает. Функция перед выдачей проверяет, что её вызвал
-- именно admin — по его собственному токену, а не по тому, что прислал
-- клиент. Подрядчик, даже зная адрес функции, получит отказ.
--
-- ============================================================================
-- ОТМЕНА ПРЕДЫДУЩЕЙ СХЕМЫ
--
-- Сначала здесь была самостоятельная смена пароля подрядчиком: система
-- объявляла пароль просроченным, человек задавал новый сам, и мы не знали ни
-- одного действующего пароля. По решению руководителя направления схема
-- заменена на выдачу: пароли выдаёт он, раз в месяц.
--
-- Разница, которую стоит понимать: теперь действующий пароль известен тому,
-- кто его выдал, и попадает в переписку, которой его передают. Взамен
-- руководитель всегда может войти в кабинет подрядчика и увидеть ровно то же,
-- что видит подрядчик, и не зависит от того, сменил ли человек пароль.
--
-- Блок ниже убирает всё, что было нужно только прежней схеме. Он безопасен на
-- базе, где её не применяли: всё через if exists.
-- ============================================================================
drop trigger if exists trg_auth_password_changed on auth.users;
drop trigger if exists trg_profile_contractor_created on profiles;
drop trigger if exists trg_profile_contractor_created_after on profiles;
drop function if exists on_auth_password_changed();
drop function if exists on_profile_contractor_created();
drop function if exists on_profile_contractor_created_after();
drop function if exists portal_confirm_password_change();
drop function if exists rotate_contractor_passwords();
drop function if exists auth_password_fingerprint(uuid);
drop table if exists contractor_password_state;

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron')
     and exists (select 1 from cron.job where jobname = 'rotate_contractor_passwords') then
    perform cron.unschedule('rotate_contractor_passwords');
    raise notice 'Расписание ротации снято — оно больше не нужно.';
  end if;
end $$;

-- ============================================================================
-- Доступ действует до даты, и ни минутой дольше
--
-- Переопределение функции из миграции 1. Изменение одно, но важное:
-- password_expires_at IS NULL больше НЕ считается бессрочным доступом. Раньше
-- так было задумано под самостоятельную смену пароля; теперь пустой срок
-- означает «пароль ещё не выдавали», и доступа быть не должно. Иначе
-- заведённый, но не выданный кабинет открылся бы сам по себе.
-- ============================================================================
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
    -- Ручной выключатель на случай «закрыть немедленно, не дожидаясь срока».
    and p.must_change_password = false
    and p.password_expires_at is not null
    and p.password_expires_at > now();
$$;

comment on function current_contractor_id() is
  'Подрядчик текущего пользователя, либо NULL. NULL у всех, кроме роли '
  'contractor с ВЫДАННЫМ и не истёкшим паролем. Пустой срок = пароль не '
  'выдавали = доступа нет.';

comment on column profiles.must_change_password is
  'Ручная приостановка доступа. Поднять — кабинет мгновенно перестаёт '
  'отдавать данные, не дожидаясь истечения пароля. Имя осталось от прежней '
  'схемы самостоятельной смены пароля.';

-- ============================================================================
-- Журнал выдач
--
-- Паролей тут нет — только кто, кому и когда выдал. Нужен для одного
-- разговора: «я этот пароль не получал». По журналу видно, выдавали ли его
-- вообще, когда и кто.
-- ============================================================================
create table if not exists contractor_access_log (
  id bigserial primary key,
  profile_id uuid references profiles(id) on delete set null,
  contractor_id uuid references contractors(id) on delete set null,
  email text,
  issued_at timestamptz not null default now(),
  issued_by_email text,
  expires_at timestamptz not null
);

create index if not exists contractor_access_log_profile_idx
  on contractor_access_log(profile_id, issued_at desc);

alter table contractor_access_log enable row level security;
drop policy if exists "staff_select" on contractor_access_log;
create policy "staff_select" on contractor_access_log for select using (is_staff());
-- Пишет только служебный ключ из Edge Function — ему RLS не указ. Политики на
-- запись нет намеренно: отметку о выдаче нельзя поставить из браузера, иначе
-- журнал ничего не доказывает.

comment on table contractor_access_log is
  'Кто, кому и когда выдал пароль. Самих паролей не содержит и содержать не '
  'должен — они показываются один раз и не хранятся.';

-- ============================================================================
-- Отметка о выдаче
--
-- Вся запись в базу при выдаче пароля — в одном месте, чтобы Edge Function
-- не раскладывала её по трём таблицам своими руками и не могла забыть часть.
-- Сам пароль в функцию не передаётся: она о нём ничего не знает.
-- ============================================================================
create or replace function portal_mark_password_issued(
  target_profile uuid,
  valid_days integer default 31,
  issued_by text default null
)
returns timestamptz
language plpgsql
security definer
set search_path = public
as $$
declare
  exp timestamptz := now() + make_interval(days => valid_days);
  prof profiles;
begin
  select * into prof from profiles where id = target_profile;
  if not found then
    raise exception 'Профиль % не найден', target_profile;
  end if;
  if prof.role <> 'contractor' then
    raise exception 'Выдавать пароли через кабинет можно только подрядчикам, у % роль %',
      prof.email, prof.role;
  end if;

  update profiles set
    must_change_password = false,
    password_rotated_at = now(),
    password_expires_at = exp
  where id = target_profile;

  insert into contractor_access_log (profile_id, contractor_id, email, issued_by_email, expires_at)
  values (target_profile, prof.contractor_id, prof.email, issued_by, exp);

  return exp;
end $$;

-- Вызывает её только служебный ключ из Edge Function. Из браузера — нельзя:
-- иначе любой залогиненный продлевал бы себе срок, не меняя пароля.
revoke all on function portal_mark_password_issued(uuid, integer, text) from public;

-- ============================================================================
-- Состояние доступов — то, что видно на экране
--
-- Главный столбец — «состояние». Он отвечает на единственный вопрос, который
-- возникает: надо ли сейчас что-то выдавать.
-- ============================================================================
drop view if exists contractor_access_status;
create view contractor_access_status with (security_invoker = true) as
select
  p.id as profile_id,
  c.id as contractor_id,
  c.name as подрядчик,
  p.email,
  case
    when p.must_change_password then 'доступ приостановлен'
    when p.password_expires_at is null then 'пароль не выдавали'
    when p.password_expires_at <= now() then 'просрочен — выдать новый'
    when p.password_expires_at <= now() + interval '5 days' then 'истекает — пора выдать'
    else 'действует'
  end as состояние,
  p.password_rotated_at as выдан,
  p.password_expires_at as действует_до,
  case
    when p.password_expires_at is null then null
    else greatest(0, ceil(extract(epoch from p.password_expires_at - now()) / 86400)::integer)
  end as дней_осталось,
  -- Сортировка для экрана: сначала то, с чем надо что-то делать.
  case
    when p.must_change_password then 0
    when p.password_expires_at is null then 1
    when p.password_expires_at <= now() then 2
    when p.password_expires_at <= now() + interval '5 days' then 3
    else 4
  end as приоритет
from profiles p
join contractors c on c.id = p.contractor_id
where p.role = 'contractor';

comment on view contractor_access_status is
  'Состояние доступов подрядчиков. Паролей тут нет: они показываются один раз '
  'при выдаче и не хранятся. Потерялся — выдать новый.';

-- ============================================================================
-- Как это выглядит в работе
--
-- 1. Один раз на подрядчика: создать пользователя в Supabase Dashboard →
--    Authentication → Users → Add user (почта подрядчика, пароль любой — он
--    всё равно будет заменён при выдаче, «Auto confirm user» включить), затем
--    привязать к подрядчику:
--
--    insert into profiles (id, email, role, contractor_id)
--    select u.id, u.email, 'contractor', c.id
--    from auth.users u, contractors c
--    where u.email = 'ПОЧТА_ПОДРЯДЧИКА'
--      and c.name = 'НАЗВАНИЕ_ПОДРЯДЧИКА'
--    on conflict (id) do update set
--      role = 'contractor', contractor_id = excluded.contractor_id;
--
--    До первой выдачи кабинет не откроется — так и задумано.
--
-- 2. Дальше каждый месяц: экран «Доступы подрядчиков» → у кого «просрочен»
--    или «истекает», нажать «Выдать пароль» → скопировать показанный пароль →
--    передать подрядчику. Пароль показывается один раз.
--
-- 3. Закрыть доступ немедленно, не удаляя кабинет:
--    update profiles set must_change_password = true where email = '…';
--    Открыть обратно — выдать новый пароль.
--
-- 4. Закрыть навсегда: delete from profiles where email = '…'; и удалить
--    пользователя в Dashboard.
-- ============================================================================
