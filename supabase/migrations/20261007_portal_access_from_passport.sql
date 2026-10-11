-- ============================================================================
-- Заведение доступа прямо из паспорта подрядчика.
--
-- ЗАЧЕМ. До этой миграции выдача доступа шла в три приёма и только один из
-- них был в приложении: сначала создать пользователя в дашборде Supabase,
-- потом выполнить вставку в profiles руками в SQL-редакторе, и только потом
-- нажать кнопку. Два шага из трёх делаются мимо приложения, вручную, на
-- память, раз в несколько месяцев — то есть ровно в тех условиях, в которых
-- ошибаются. Самая вероятная ошибка тут не опечатка в почте (она видна
-- сразу), а привязка к НЕ ТОМУ подрядчику: названия похожи, их полтора
-- десятка, и человек увидит чужие заявки.
--
-- Теперь подрядчик известен из самого паспорта — выбирать его не нужно и
-- ошибиться в нём нельзя.
--
-- ЧТО ЗДЕСЬ. Две вспомогательные функции для Edge Function portal-access.
-- Обе нужны потому, что схема auth принадлежит GoTrue и обычным запросом из
-- приложения её не прочитать и не изменить.
-- ============================================================================

-- --- Есть ли уже такой пользователь ----------------------------------------
-- Нужна, чтобы заведение доступа было повторяемым. Почту могли уже завести
-- в дашборде руками (так и делали до сих пор), и в этом случае правильное
-- поведение — подхватить существующего пользователя и задать ему пароль, а
-- не падать с «email already registered» и не оставлять руководителя гадать,
-- что делать дальше.
create or replace function portal_find_auth_user(user_email text)
returns uuid
language sql
security definer
set search_path = public
stable
as $$
  select u.id from auth.users u
  where lower(u.email) = lower(trim(user_email))
  limit 1;
$$;

revoke all on function portal_find_auth_user(text) from public;

-- --- Отзыв доступа ----------------------------------------------------------
-- Удаляет профиль и оставляет отметку в журнале. Самого пользователя из
-- auth.users удаляет Edge Function служебным ключом — отсюда это сделать
-- нельзя, чужая схема.
--
-- ПОРЯДОК ВАЖЕН: сначала запись в журнал, потом удаление профиля. Наоборот
-- не получится — в журнале стоит ссылка на профиль, и она обнулится.
create or replace function portal_revoke_access(target_profile uuid, revoked_by text default null)
returns boolean
language plpgsql
security definer
set search_path = public
as $$
declare prof profiles;
begin
  select * into prof from profiles where id = target_profile;
  if not found then
    return false;
  end if;
  if prof.role <> 'contractor' then
    raise exception 'Через кабинет отзывается только доступ подрядчика, у % роль %',
      prof.email, prof.role;
  end if;

  insert into contractor_access_log (profile_id, contractor_id, email, issued_by_email, expires_at)
  values (null, prof.contractor_id, prof.email,
          coalesce(revoked_by, '—') || ' (отзыв)', now());

  delete from profiles where id = target_profile;
  return true;
end $$;

revoke all on function portal_revoke_access(uuid, text) from public;

comment on function portal_revoke_access(uuid, text) is
  'Удаляет профиль подрядчика и пишет отметку в журнал. Пользователя в '
  'auth.users удаляет Edge Function. Вызывается только служебным ключом.';

-- Отдельной вьюхи для паспорта нет и не нужно: contractor_access_status
-- отдаёт contractor_id, и паспорт берёт из неё свою единственную строку.
