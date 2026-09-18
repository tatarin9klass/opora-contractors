import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// Импорт направления АВТОПРАВО / АВАРКОМ из Битрикса.
//
// Отдельная функция, а не флаг внутри bitrix-import: у направлений разная
// логика (там — дневные факты воронки БФЛ, здесь — лиды по префиксу источника
// и текущие стадии сделок в воронках 8 и 36), и ломать рабочий БФЛ ради
// общего кода незачем.
//
// ЧТО ИМЕННО СЧИТАЕТСЯ:
//   * лид — любой лид с источником, чьё имя начинается на avtpr/avrkm.
//     Стадия лида не смотрится вообще;
//   * договор — сделка в воронке 8 или 36, которая СЕЙЧАС стоит на одной из
//     стадий, перечисленных в таблице ap_contract_stages. Именно "сейчас":
//     договор мог потом уйти в брак, но факт его заключения нам важен.
//
// ПОЧЕМУ ФАЗАМИ: за январь–сентябрь это тысячи лидов и сделок, Битрикс отдаёт
// по 50 записей на запрос, и в один вызов Edge Function (лимит по времени) всё
// это не влезает. Поэтому функция работает "сколько успеет", сохраняет позицию
// в ap_sync_state и возвращает done=false — фронт просто вызывает её повторно,
// пока не придёт done=true.
// ============================================================================

const BITRIX_WEBHOOK = "https://stopdolg.bitrix24.ru/rest/2708/krxomqqp0tb1b0jc";

// Воронки сделок направления.
const CATEGORY_AVTPR = 8;   // "Автоправо. Продажи"
const CATEGORY_AVRKM = 36;  // "Аварийные комиссары"

// Раньше этой даты данные направления не грузим.
const MIN_DATE = "2026-01-01";

// Бюджет времени на один вызов. Ниже реального лимита Edge Function, чтобы
// успеть корректно сохранить курсор и вернуть ответ, а не оборваться на
// середине страницы.
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

function toDateMsk(isoStr: string): string {
  if (!isoStr) return "";
  const msk = new Date(new Date(isoStr).getTime() + 3 * 60 * 60 * 1000);
  return msk.toISOString().split("T")[0];
}

// Направление определяется по префиксу имени источника. В Битриксе разделитель
// после префикса встречается разный ("Avtpr. Сайт Опора (ЗВ)", "avrkm - звонок
// моп"), и регистр тоже гуляет — поэтому \b, а не жёсткое "avtpr.".
function directionOf(name: string): "avtpr" | "avrkm" | null {
  const m = (name || "").trim().toLowerCase().match(/^(avtpr|avrkm)\b/);
  return m ? (m[1] as "avtpr" | "avrkm") : null;
}

// Все источники направления: STATUS_ID -> { name, direction }.
async function buildSourceMap(): Promise<Map<string, { name: string; direction: "avtpr" | "avrkm" }>> {
  const map = new Map<string, { name: string; direction: "avtpr" | "avrkm" }>();
  let start = 0;
  while (true) {
    const json = await bitrixCall("crm.status.list", {
      filter: { ENTITY_ID: "SOURCE" },
      select: ["STATUS_ID", "NAME"],
      start,
    });
    for (const s of json.result || []) {
      const dir = directionOf(s.NAME);
      if (dir) map.set(String(s.STATUS_ID), { name: s.NAME, direction: dir });
    }
    if (!json.next) break;
    start = json.next;
  }
  return map;
}

// ---- состояние синхронизации ----

async function readState(supabase: any): Promise<Record<string, string>> {
  const { data } = await supabase.from("ap_sync_state").select("key, value");
  const out: Record<string, string> = {};
  for (const row of data || []) out[row.key] = row.value;
  return out;
}

async function writeState(supabase: any, patch: Record<string, string>) {
  const rows = Object.entries(patch).map(([key, value]) => ({ key, value, updated_at: new Date().toISOString() }));
  if (rows.length) await supabase.from("ap_sync_state").upsert(rows, { onConflict: "key" });
}

async function upsertChunked(supabase: any, table: string, rows: any[], onConflict: string) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + 500), { onConflict });
    if (error) throw new Error(`${table} upsert: ${error.message}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startedAt = Date.now();
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - startedAt);

  try {
    const body = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    // --- источники направления -------------------------------------------
    const sourceMap = await buildSourceMap();
    if (sourceMap.size === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: "В Битриксе не найдено ни одного источника с префиксом avtpr/avrkm.",
      }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const { data: knownSources } = await supabase.from("ap_sources").select("bitrix_name");
    const knownNames = new Set((knownSources || []).map((s: any) => s.bitrix_name));

    const newSources = [...sourceMap.values()]
      .filter((s) => !knownNames.has(s.name))
      .map((s) => ({
        bitrix_name: s.name,
        direction: s.direction,
        // Новый источник всегда заводится без канала — и в Автоправе, и в
        // Аваркоме: в обоих направлениях групп каналов по несколько, угадать
        // за пользователя нельзя. Непривязанные видны на странице импорта.
        channel_id: null,
      }));
    if (newSources.length) {
      await upsertChunked(supabase, "ap_sources", newSources, "bitrix_name");
    }

    const sourceIds = [...sourceMap.keys()];

    // --- фазы -------------------------------------------------------------
    const state = await readState(supabase);
    let phase = body.reset ? "" : (state.phase || "");
    let leadsLastId = body.reset ? 0 : Number(state.leads_last_id || 0);
    let dealsScan = body.reset ? 0 : Number(state.deals_scan_start || 0);

    // Начало нового цикла. Лиды догружаем инкрементально (у лида ни источник,
    // ни дата создания задним числом не меняются), а сделки пересканируем
    // ЦЕЛИКОМ каждый цикл: у них меняется текущая стадия, а именно она решает,
    // договор это или нет. Сделок в обеих воронках немного, это недорого.
    if (phase === "" || phase === "idle") {
      phase = "leads";
      dealsScan = 0;
      await writeState(supabase, { phase, deals_scan_start: "0" });
    }
    if (body.reset) {
      leadsLastId = 0;
      await writeState(supabase, { phase: "leads", leads_last_id: "0", deals_scan_start: "0" });
      phase = "leads";
    }

    let leadsUpserted = 0;
    let dealsUpserted = 0;
    let done = false;

    // --- фаза 1: лиды по >ID -----------------------------------------------
    while (phase === "leads" && timeLeft() > 8000) {
      const json = await bitrixCall("crm.lead.list", {
        filter: { SOURCE_ID: sourceIds, ">ID": leadsLastId },
        select: ["ID", "SOURCE_ID", "DATE_CREATE"],
        order: { ID: "ASC" },
        start: 0,
      });
      const page: any[] = json.result || [];
      if (page.length === 0) {
        phase = "deals";
        dealsScan = 0;
        await writeState(supabase, { phase, deals_scan_start: "0" });
        break;
      }

      const rows: any[] = [];
      for (const lead of page) {
        const src = sourceMap.get(String(lead.SOURCE_ID || ""));
        if (!src) continue;
        const created = toDateMsk(lead.DATE_CREATE);
        if (!created || created < MIN_DATE) continue;
        rows.push({
          lead_id: Number(lead.ID),
          source_name: src.name,
          direction: src.direction,
          created_date: created,
          synced_at: new Date().toISOString(),
        });
      }
      if (rows.length) {
        await upsertChunked(supabase, "ap_leads", rows, "lead_id");
        leadsUpserted += rows.length;
      }

      leadsLastId = Math.max(...page.map((l: any) => Number(l.ID)));
      await writeState(supabase, { leads_last_id: String(leadsLastId) });
    }

    // --- фаза 2: сделки воронок 8 и 36, полный проход -----------------------
    // Битрикс не даёт надёжно фильтровать по системным датам, поэтому просто
    // проходим обе воронки подряд постранично (start — сквозное смещение).
    while (phase === "deals" && timeLeft() > 8000) {
      const json = await bitrixCall("crm.deal.list", {
        filter: { CATEGORY_ID: [CATEGORY_AVTPR, CATEGORY_AVRKM] },
        select: ["ID", "LEAD_ID", "CATEGORY_ID", "STAGE_ID", "SOURCE_ID", "DATE_CREATE"],
        order: { ID: "ASC" },
        start: dealsScan,
      });
      const page: any[] = json.result || [];
      if (page.length === 0) {
        phase = "idle";
        done = true;
        await writeState(supabase, { phase, deals_scan_start: "0" });
        break;
      }

      const rows = page.map((d: any) => ({
        deal_id: Number(d.ID),
        lead_id: d.LEAD_ID ? Number(d.LEAD_ID) : null,
        category_id: Number(d.CATEGORY_ID),
        stage_id: String(d.STAGE_ID || ""),
        source_name: sourceMap.get(String(d.SOURCE_ID || ""))?.name ?? null,
        deal_created_date: toDateMsk(d.DATE_CREATE) || MIN_DATE,
        synced_at: new Date().toISOString(),
      }));
      await upsertChunked(supabase, "ap_deals", rows, "deal_id");
      dealsUpserted += rows.length;

      if (!json.next) {
        phase = "idle";
        done = true;
        await writeState(supabase, { phase, deals_scan_start: "0" });
        break;
      }
      dealsScan = json.next;
      await writeState(supabase, { deals_scan_start: String(dealsScan) });
    }

    // --- источники без канала (их надо привязать руками) --------------------
    const { data: unmappedRows } = await supabase
      .from("ap_sources").select("id, bitrix_name, direction").is("channel_id", null);

    return new Response(JSON.stringify({
      success: true,
      done,
      phase,
      leads_upserted: leadsUpserted,
      deals_upserted: dealsUpserted,
      leads_last_id: leadsLastId,
      deals_scan_start: phase === "deals" ? dealsScan : 0,
      new_sources: newSources.map((s) => s.bitrix_name),
      unmapped_sources: unmappedRows || [],
      elapsed_ms: Date.now() - startedAt,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("avtp-import error:", String(err));
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
