import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// Импорт звонков по лидам БФЛ.
//
// ПРО СКОРОСТЬ — это здесь главное. Активностей в портале 1,7 млн, и обычный
// запрос к crm.activity.list отрабатывал 29 СЕКУНД на страницу в 50 записей.
// Причина не в объёме выдачи, а в том, что Битрикс на каждый запрос считает
// total по всей таблице. Лечится штатным быстрым режимом постраничной
// навигации: курсор по ">ID" вместо сортировки и start = -1, который
// отключает подсчёт. Без этого импорт физически не выполним — 34 тысячи
// запросов по полминуты.
//
// ПРО ДОЗВОН. Явного поля «взяли трубку» в активности нет. Надёжный признак —
// запись разговора: у отвеченных звонков она есть и длительность больше нуля,
// у неотвеченных записи нет и START_TIME совпадает с END_TIME. Храним и то, и
// другое, чтобы правило можно было перепроверить на данных, а не верить на
// слово.
//
// COMPLETED = 'N' — это запланированные звонки («перезвонить 8 октября»),
// а не состоявшиеся. Храним с флагом, в витрины они не идут.
// ============================================================================

const BITRIX_WEBHOOK = "https://stopdolg.bitrix24.ru/rest/2708/krxomqqp0tb1b0jc";

const ACTIVITY_TYPE_CALL = 2;   // звонок
const OWNER_TYPE_LEAD = 1;      // владелец активности — лид

const TIME_BUDGET_MS = 90_000;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

async function bitrixCall(method: string, params: Record<string, unknown>) {
  const res = await fetch(`${BITRIX_WEBHOOK}/${method}.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(params),
  });
  const json = await res.json();
  if (json.error) throw new Error(`Bitrix error [${method}]: ${json.error_description || json.error}`);
  return json;
}

function toIso(raw: unknown): string | null {
  if (!raw) return null;
  const d = new Date(String(raw));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

async function buildUserMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let start = 0;
  while (true) {
    const json = await bitrixCall("user.get", { start });
    const page: any[] = json.result || [];
    if (page.length === 0) break;
    for (const u of page) {
      const name = [u.LAST_NAME, u.NAME].filter(Boolean).join(" ").trim();
      map.set(String(u.ID), name || `id ${u.ID}`);
    }
    if (!json.next) break;
    start = json.next;
  }
  return map;
}

async function readState(supabase: any): Promise<Record<string, string>> {
  const { data } = await supabase.from("bfl_calls_sync_state").select("key, value");
  const out: Record<string, string> = {};
  for (const row of data || []) out[row.key] = row.value;
  return out;
}

async function writeState(supabase: any, patch: Record<string, string>) {
  const rows = Object.entries(patch).map(([key, value]) => ({ key, value, updated_at: new Date().toISOString() }));
  if (rows.length) await supabase.from("bfl_calls_sync_state").upsert(rows, { onConflict: "key" });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startedAt = Date.now();
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - startedAt);

  try {
    const body = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const state = await readState(supabase);
    let cursor = body.reset ? 0 : Number(state.calls_last_id || 0);

    // Нижняя граница по лидам — из уже загруженной таблицы лидов, чтобы не
    // тянуть звонки за все годы.
    let minLeadId = Number(state.min_lead_id || 0);
    if (!minLeadId || body.reset) {
      const { data } = await supabase
        .from("bfl_lead_timings").select("lead_id").order("lead_id", { ascending: true }).limit(1);
      minLeadId = Number(data?.[0]?.lead_id || 0);
      await writeState(supabase, { min_lead_id: String(minLeadId) });
    }
    if (body.reset) {
      cursor = 0;
      await writeState(supabase, { calls_last_id: "0" });
    }

    const userMap = await buildUserMap().catch((e) => {
      console.error("user.get failed:", String(e));
      return new Map<string, string>();
    });

    let imported = 0;
    let scanned = 0;
    let done = false;

    while (timeLeft() > 10000) {
      const json = await bitrixCall("crm.activity.list", {
        filter: {
          ">ID": cursor,
          OWNER_TYPE_ID: OWNER_TYPE_LEAD,
          TYPE_ID: ACTIVITY_TYPE_CALL,
          ">OWNER_ID": minLeadId,
        },
        select: [
          "ID", "OWNER_ID", "RESPONSIBLE_ID", "DIRECTION", "COMPLETED",
          "START_TIME", "END_TIME", "ORIGIN_ID", "SUBJECT", "FILES",
        ],
        order: { ID: "ASC" },
        // Отключает подсчёт total — без этого каждый запрос считает 1,7 млн строк.
        start: -1,
      });
      const page: any[] = json.result || [];
      if (page.length === 0) {
        done = true;
        break;
      }
      scanned += page.length;

      const rows = page.map((a: any) => {
        const startIso = toIso(a.START_TIME);
        const endIso = toIso(a.END_TIME);
        const dur = (startIso && endIso)
          ? Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 1000)
          : null;
        return {
          id: Number(a.ID),
          lead_id: Number(a.OWNER_ID),
          responsible_id: a.RESPONSIBLE_ID ? Number(a.RESPONSIBLE_ID) : null,
          responsible_name: userMap.get(String(a.RESPONSIBLE_ID || "")) ?? null,
          direction: a.DIRECTION ? Number(a.DIRECTION) : null,
          completed: a.COMPLETED === "Y",
          started_at: startIso,
          ended_at: endIso,
          duration_sec: dur,
          has_recording: Array.isArray(a.FILES) && a.FILES.length > 0,
          origin_id: a.ORIGIN_ID ?? null,
          subject: a.SUBJECT ?? null,
          synced_at: new Date().toISOString(),
        };
      });

      for (let i = 0; i < rows.length; i += 500) {
        const { error } = await supabase
          .from("bfl_lead_calls").upsert(rows.slice(i, i + 500), { onConflict: "id" });
        if (error) throw new Error(`bfl_lead_calls upsert: ${error.message}`);
      }
      imported += rows.length;

      cursor = Math.max(...page.map((a: any) => Number(a.ID)));
      await writeState(supabase, { calls_last_id: String(cursor) });
    }

    return new Response(JSON.stringify({
      success: true,
      done,
      imported,
      scanned,
      cursor,
      min_lead_id: minLeadId,
      elapsed_ms: Date.now() - startedAt,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("bfl-calls error:", String(err));
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
