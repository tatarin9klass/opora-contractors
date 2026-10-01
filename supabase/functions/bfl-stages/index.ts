import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// Импорт истории стадий воронки лидов БФЛ.
//
// Снимок текущих стадий отвечает на вопрос «где лид стоит», но не на вопрос
// «через что он прошёл». А нужен именно второй: какая доля вошедших в
// «Не удалось дозвониться», «Скорозвон» и «Дозвонились» доходит до квала.
// Лид, которого вытащили из недозвона, сейчас стоит на другой стадии, и в
// статистике недозвона его не видно — поэтому нужна история переходов.
//
// Объём большой: на каждый лид приходится по несколько переходов, Битрикс
// отдаёт по 50 записей за запрос. Поэтому работа идёт фазами с курсором,
// как в предыдущих импортах: функция делает сколько успеет и возвращает
// done=false, фронт дёргает её по кругу.
// ============================================================================

const BITRIX_WEBHOOK = "https://stopdolg.bitrix24.ru/rest/2708/krxomqqp0tb1b0jc";

// entityTypeId = 1 — лиды.
const LEAD_ENTITY_TYPE_ID = 1;

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

async function buildLeadStatusMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let start = 0;
  while (true) {
    const json = await bitrixCall("crm.status.list", {
      filter: { ENTITY_ID: "STATUS" },
      select: ["STATUS_ID", "NAME"],
      start,
    });
    for (const s of json.result || []) map.set(String(s.STATUS_ID), s.NAME);
    if (!json.next) break;
    start = json.next;
  }
  return map;
}

async function readState(supabase: any): Promise<Record<string, string>> {
  const { data } = await supabase.from("bfl_stage_sync_state").select("key, value");
  const out: Record<string, string> = {};
  for (const row of data || []) out[row.key] = row.value;
  return out;
}

async function writeState(supabase: any, patch: Record<string, string>) {
  const rows = Object.entries(patch).map(([key, value]) => ({ key, value, updated_at: new Date().toISOString() }));
  if (rows.length) await supabase.from("bfl_stage_sync_state").upsert(rows, { onConflict: "key" });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startedAt = Date.now();
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - startedAt);

  try {
    const body = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const state = await readState(supabase);
    let cursor = body.reset ? 0 : Number(state.history_last_id || 0);

    // Нижняя граница по лидам: берём минимальный загруженный лид БФЛ, чтобы
    // не тянуть историю за все годы. Границу считает не двоичный поиск, а
    // уже загруженная таблица лидов — дешевле и точнее.
    let minLeadId = Number(state.min_lead_id || 0);
    if (!minLeadId || body.reset) {
      const { data } = await supabase
        .from("bfl_lead_timings").select("lead_id").order("lead_id", { ascending: true }).limit(1);
      minLeadId = Number(data?.[0]?.lead_id || 0);
      await writeState(supabase, { min_lead_id: String(minLeadId) });
    }
    if (body.reset) {
      cursor = 0;
      await writeState(supabase, { history_last_id: "0" });
    }

    const statusMap = await buildLeadStatusMap();

    let imported = 0;
    let scanned = 0;
    let done = false;

    while (timeLeft() > 8000) {
      const json = await bitrixCall("crm.stagehistory.list", {
        entityTypeId: LEAD_ENTITY_TYPE_ID,
        filter: { ">ID": cursor, ">OWNER_ID": minLeadId },
        select: ["ID", "OWNER_ID", "CREATED_TIME", "STATUS_ID"],
        order: { ID: "ASC" },
        start: 0,
      });
      const page: any[] = json.result?.items || [];
      if (page.length === 0) {
        done = true;
        break;
      }
      scanned += page.length;

      const rows: any[] = [];
      for (const h of page) {
        const at = toIso(h.CREATED_TIME);
        if (!at) continue;
        const sid = String(h.STATUS_ID || "");
        rows.push({
          id: Number(h.ID),
          lead_id: Number(h.OWNER_ID),
          status_id: sid,
          status_name: statusMap.get(sid) ?? null,
          entered_at: at,
          synced_at: new Date().toISOString(),
        });
      }
      if (rows.length) {
        for (let i = 0; i < rows.length; i += 500) {
          const { error } = await supabase
            .from("bfl_lead_stage_history").upsert(rows.slice(i, i + 500), { onConflict: "id" });
          if (error) throw new Error(`bfl_lead_stage_history upsert: ${error.message}`);
        }
        imported += rows.length;
      }

      cursor = Math.max(...page.map((h: any) => Number(h.ID)));
      await writeState(supabase, { history_last_id: String(cursor) });
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
    console.error("bfl-stages error:", String(err));
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
