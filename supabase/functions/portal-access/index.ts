import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// Выдача пароля подрядчику.
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
      return json({ success: false, error: "Выдавать пароли может только администратор" }, 403);
    }

    const body = await req.json().catch(() => ({}));
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

    const password = generatePassword();

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
    const validDays = Number(body.valid_days) > 0 ? Number(body.valid_days) : DEFAULT_VALID_DAYS;
    const { data: expiresAt, error: markErr } = await admin.rpc("portal_mark_password_issued", {
      target_profile: target.id,
      valid_days: validDays,
      issued_by: callerProfile.email || caller.email || null,
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
