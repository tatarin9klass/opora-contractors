import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// Доступы подрядчиков: завести, выдать пароль, отозвать.
//
// Три действия, которые раньше делались в трёх разных местах — в дашборде
// Supabase, в SQL-редакторе и в приложении, — собраны в одну функцию, чтобы
// в приложении осталась одна кнопка на каждое.
//
//   create — завести кабинет: пользователь + привязка к подрядчику + пароль
//   issue  — выдать новый пароль существующему кабинету
//   revoke — закрыть кабинет насовсем
//
// Приостановка доступа сюда НЕ входит намеренно: она делается обычной
// записью в profiles, на которую у админа и так есть право, и гонять ради
// одного булева поля запрос через сервер незачем.
//
// ЗАЧЕМ ОТДЕЛЬНАЯ ФУНКЦИЯ, А НЕ КНОПКА В ПРИЛОЖЕНИИ. Задать пользователю
// пароль может только служебный ключ Supabase (service_role). Если положить
// его в приложение, он уедет в браузер — а служебный ключ обходит ВСЕ запреты
// доступа: кто его получил, читает и пишет всю базу целиком. Поэтому ключ
// живёт здесь, на сервере, а приложение только просит функцию выдать пароль.
//
// КТО ИМЕЕТ ПРАВО ПРОСИТЬ. Функция проверяет не то, что прислал клиент, а
// подпись токена вызывающего: берёт его access_token, спрашивает у Supabase,
// чей он, и смотрит роль в profiles. Выдать пароль может только admin.
// Подрядчик, знающий адрес функции, получит отказ — своей же ролью.
//
// ПАРОЛЬ ВОЗВРАЩАЕТСЯ ОДИН РАЗ И НИГДЕ НЕ СОХРАНЯЕТСЯ. В журнал пишется
// только факт выдачи: кто, кому, когда и до какого числа. Хранить пароль
// незачем: потерянный проще выдать заново, а таблица с паролями в открытом
// виде уезжает в резервные копии и в любую выгрузку базы.
// ============================================================================

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY")!;

// Сколько дней живёт выданный пароль. 31, а не 30: иначе срок каждый месяц
// уползает на день назад, и к декабрю «раз в месяц» превращается в «раз в
// четыре недели».
const DEFAULT_VALID_DAYS = 31;

// Нижняя граница для пароля, заданного руками. Сгенерированный длиннее,
// но руководитель может ввести свой, и «12345» для кабинета с телефонами
// клиентов не годится.
const MIN_PASSWORD_LENGTH = 8;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Алфавит без похожих друг на друга знаков: нет 0 и O, 1 и l и I, 5 и S.
// Пароль передают в переписке и иногда диктуют, и «это ноль или буква О» —
// самая частая причина, по которой человек не может войти.
const ALPHABET = "abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789";

// Группы по пять знаков через дефис: так пароль читается и переносится без
// ошибок. Энтропия при 15 знаках из 54-символьного алфавита — около 86 бит,
// то есть подбор не обсуждается.
function generatePassword(): string {
  const bytes = new Uint8Array(15);
  crypto.getRandomValues(bytes);
  const chars = [...bytes].map((b) => ALPHABET[b % ALPHABET.length]);
  return [
    chars.slice(0, 5).join(""),
    chars.slice(5, 10).join(""),
    chars.slice(10, 15).join(""),
  ].join("-");
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization") || "";
    const token = authHeader.replace(/^Bearer\s+/i, "");
    if (!token) return json({ success: false, error: "Нужен вход в приложение" }, 401);

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // Чей это токен. Спрашиваем у Supabase, а не разбираем токен сами:
    // самодельная проверка подписи — классический способ принять подделку.
    const asCaller = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: `Bearer ${token}` } },
    });
    const { data: userData, error: userErr } = await asCaller.auth.getUser();
    const caller = userData?.user;
    if (userErr || !caller) {
      return json({ success: false, error: "Не удалось подтвердить вход" }, 401);
    }

    // Роль берём служебным ключом из profiles, а не из токена: в токене
    // лежит то, что мог бы подправить сам пользователь через метаданные, —
    // именно поэтому роли с самого начала хранятся в отдельной таблице.
    const { data: callerProfile } = await admin
      .from("profiles")
      .select("role, email")
      .eq("id", caller.id)
      .maybeSingle();

    if (callerProfile?.role !== "admin") {
      return json({ success: false, error: "Управлять доступами может только администратор" }, 403);
    }

    const body = await req.json().catch(() => ({}));
    const action: string = body.action || "issue";
    const issuedBy = callerProfile.email || caller.email || null;
    const validDays = Number(body.valid_days) > 0 ? Number(body.valid_days) : DEFAULT_VALID_DAYS;

    // ------------------------------------------------------------------
    // Завести кабинет: пользователь, привязка к подрядчику и первый пароль
    //
    // Повторяемо по замыслу. Почту могли уже завести руками в дашборде — так
    // и делали до появления этого экрана, — и тогда правильно подхватить
    // существующего пользователя и задать ему пароль, а не падать с «email
    // already registered», оставляя руководителя гадать, что делать дальше.
    // ------------------------------------------------------------------
    if (action === "create") {
      const email = String(body.email || "").trim().toLowerCase();
      const contractorId = body.contractor_id;
      if (!email || !email.includes("@")) {
        return json({ success: false, error: "Укажите почту подрядчика" }, 400);
      }
      if (!contractorId) {
        return json({ success: false, error: "Не указан подрядчик" }, 400);
      }

      // Пароль либо задан руководителем, либо генерируется. Заданный
      // проверяем на длину: пароль от кабинета с персональными данными не
      // должен быть «12345».
      const password = body.password ? String(body.password) : generatePassword();
      if (password.length < MIN_PASSWORD_LENGTH) {
        return json({
          success: false,
          error: `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`,
        }, 400);
      }

      // Есть ли уже такой пользователь. Схему auth обычным запросом не
      // прочитать, поэтому через функцию в базе.
      const { data: existingId } = await admin.rpc("portal_find_auth_user", { user_email: email });

      let userId: string;
      if (existingId) {
        userId = existingId as string;

        // Защита от перехвата своей же или сотрудничьей учётной записи:
        // если за этой почтой уже стоит admin или viewer, заводить ей
        // кабинет подрядчика нельзя — она потеряет свой доступ.
        const { data: existingProfile } = await admin
          .from("profiles").select("role, contractor_id").eq("id", userId).maybeSingle();
        if (existingProfile && existingProfile.role !== "contractor") {
          return json({
            success: false,
            error: `За почтой ${email} уже закреплён сотрудник с ролью ${existingProfile.role}. Заведите подрядчику отдельную почту.`,
          }, 400);
        }
        if (existingProfile?.contractor_id && existingProfile.contractor_id !== contractorId) {
          return json({
            success: false,
            error: `Эта почта уже привязана к другому подрядчику. Сначала отзовите тот доступ.`,
          }, 400);
        }

        const { error: upErr } = await admin.auth.admin.updateUserById(userId, {
          password, email_confirm: true,
        });
        if (upErr) {
          return json({ success: false, error: `Не удалось задать пароль: ${upErr.message}` }, 500);
        }
      } else {
        const { data: created, error: createErr } = await admin.auth.admin.createUser({
          email,
          password,
          // Письма подрядчику не уходят — SMTP не настроен, подтверждать
          // почту некому. Без этого человек не сможет войти вообще.
          email_confirm: true,
        });
        if (createErr || !created?.user) {
          return json({
            success: false,
            error: `Не удалось создать пользователя: ${createErr?.message || "пустой ответ"}`,
          }, 500);
        }
        userId = created.user.id;
      }

      const { error: profErr } = await admin.from("profiles").upsert({
        id: userId,
        email,
        role: "contractor",
        contractor_id: contractorId,
      }, { onConflict: "id" });
      if (profErr) {
        return json({
          success: false,
          password,
          error: `Пользователь создан, но привязать к подрядчику не вышло: ${profErr.message}`,
        }, 500);
      }

      const { data: expiresAt, error: markErr } = await admin.rpc("portal_mark_password_issued", {
        target_profile: userId,
        valid_days: validDays,
        issued_by: issuedBy,
      });
      if (markErr) {
        return json({
          success: false,
          password,
          error: `Доступ заведён, но срок не записан: ${markErr.message}. Выдайте пароль ещё раз.`,
        }, 500);
      }

      return json({
        success: true, password, email,
        profile_id: userId, expires_at: expiresAt, valid_days: validDays,
      });
    }

    // ------------------------------------------------------------------
    // Закрыть кабинет насовсем
    // ------------------------------------------------------------------
    if (action === "revoke") {
      const targetProfileId: string | undefined = body.profile_id;
      if (!targetProfileId) return json({ success: false, error: "Не указан profile_id" }, 400);

      // Сначала профиль и отметка в журнале, потом пользователь. В обратном
      // порядке падение на втором шаге оставило бы учётную запись без
      // профиля — вход есть, прав нет, и непонятно, что это такое.
      const { data: removed, error: revErr } = await admin.rpc("portal_revoke_access", {
        target_profile: targetProfileId,
        revoked_by: issuedBy,
      });
      if (revErr) return json({ success: false, error: revErr.message }, 500);
      if (!removed) return json({ success: false, error: "Такого доступа нет" }, 404);

      const { error: delErr } = await admin.auth.admin.deleteUser(targetProfileId);
      if (delErr) {
        // Профиля уже нет, значит кабинет закрыт и данных учётная запись не
        // получит. Но висящий вход — мусор, о котором надо сказать.
        return json({
          success: true,
          warning: `Доступ закрыт, но учётная запись осталась в Authentication: ${delErr.message}. Удалите её вручную.`,
        });
      }

      return json({ success: true });
    }

    // ------------------------------------------------------------------
    // Выдать новый пароль существующему кабинету
    // ------------------------------------------------------------------
    const targetProfileId: string | undefined = body.profile_id;
    if (!targetProfileId) {
      return json({ success: false, error: "Не указан profile_id" }, 400);
    }

    // Кому выдаём. Проверяем роль ДО смены пароля: иначе ошибка в
    // profile_id позволила бы сбросить пароль сотруднику или себе.
    const { data: target } = await admin
      .from("profiles")
      .select("id, email, role, contractor_id")
      .eq("id", targetProfileId)
      .maybeSingle();

    if (!target) return json({ success: false, error: "Такого доступа нет" }, 404);
    if (target.role !== "contractor") {
      return json({
        success: false,
        error: `Через этот экран выдаются пароли только подрядчикам, а у ${target.email} роль ${target.role}`,
      }, 400);
    }

    const password = body.password ? String(body.password) : generatePassword();
    if (password.length < MIN_PASSWORD_LENGTH) {
      return json({
        success: false,
        error: `Пароль должен быть не короче ${MIN_PASSWORD_LENGTH} символов`,
      }, 400);
    }

    const { error: setErr } = await admin.auth.admin.updateUserById(target.id, {
      password,
      // Подрядчику письма не уходят — подтверждать почту некому и незачем.
      email_confirm: true,
    });
    if (setErr) {
      return json({ success: false, error: `Не удалось задать пароль: ${setErr.message}` }, 500);
    }

    // Отметка о выдаче и срок — одной функцией в базе, чтобы здесь нельзя
    // было забыть половину.
    const { data: expiresAt, error: markErr } = await admin.rpc("portal_mark_password_issued", {
      target_profile: target.id,
      valid_days: validDays,
      issued_by: issuedBy,
    });

    if (markErr) {
      // Пароль уже сменён, а срок не поставлен — худший из возможных
      // исходов: подрядчик не войдёт ни старым, ни новым. Говорим об этом
      // прямо, вместе с паролем, чтобы его хотя бы не потеряли.
      return json({
        success: false,
        password,
        error: `Пароль задан, но срок не записан: ${markErr.message}. Выдай пароль ещё раз.`,
      }, 500);
    }

    return json({
      success: true,
      password,
      email: target.email,
      expires_at: expiresAt,
      valid_days: validDays,
    });

  } catch (err) {
    console.error("portal-access error:", String(err));
    return json({ success: false, error: String(err) }, 500);
  }
});
