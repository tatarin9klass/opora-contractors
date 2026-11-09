import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// Импорт агентской сети: карточки агентов, их движение по воронке, а также
// лиды и сделки, приведённые при их участии.
//
// ЧЕТЫРЕ ФАЗЫ, КАЖДАЯ СО СВОИМ КУРСОРОМ:
//
//   agents  — элементы смарт-процесса 1120 (сами агенты);
//   history — история переходов по стадиям, ради «+пришло / −ушло»;
//   leads   — лиды, у которых заполнено поле PARENT_ID_1120;
//   deals   — сделки с тем же полем.
//
// ПОЧЕМУ ФАЗЫ, ХОТЯ ЗАПРОСОВ НЕМНОГО. Всё четыре фазы — постраничный проход,
// около ста тридцати запросов, и обычно они укладываются в один вызов. Но
// база агентов растёт, а связь с Битриксом рвётся регулярно; фаза с
// курсором переживает обрыв без потери сделанного, а один проход — нет.
//
// ПРОХОД ВСЕГДА ПОЛНЫЙ, БЕЗ ОКНА ПО ДАТАМ. Поле «СП агенты» проставляют и
// задним числом: лид мог прийти в апреле, а агента к нему привязать в
// ноябре. Инкрементальный импорт по дате создания такую привязку не
// увидел бы никогда.
//
// ОТВЯЗАННЫЕ СТРОКИ УДАЛЯЮТСЯ, А НЕ ОСТАЮТСЯ. Если у лида убрали агента,
// upsert его не тронет и лид навсегда останется в агентской статистике.
// Поэтому в начале цикла запоминается время, а в конце всё, что не было
// обновлено за этот цикл, удаляется.
// ============================================================================

const BITRIX_WEBHOOK = "https://stopdolg.bitrix24.ru/rest/2708/krxomqqp0tb1b0jc";

const AGENT_ENTITY_TYPE = 1120;          // смарт-процесс «Агенты»
const AGENT_LINK_FIELD = "PARENT_ID_1120";
const LEAD_QUAL_FIELD = "UF_CRM_DATETIME_KVAL_LIDA_KL";
const DEAL_PAID_FIELD = "UF_CRM_1744372636";

const TIME_BUDGET_MS = 90_000;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Повторы обязательны, а не предосторожность: связь между Supabase и
// Битриксом рвётся регулярно, и один разрыв без повторов роняет весь проход.
// Повторяем только сетевое и временное — «нет прав» повторять бессмысленно.
async function bitrix(method: string, params: Record<string, unknown>, attempt = 1): Promise<any> {
  const MAX_ATTEMPTS = 4;
  try {
    const res = await fetch(`${BITRIX_WEBHOOK}/${method}.json`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    });
    const json = await res.json();
    if (json.error) {
      throw new Error(`Bitrix [${method}]: ${json.error_description || json.error}`);
    }
    return json;
  } catch (err) {
    const text = String(err);
    const isBitrixError = text.startsWith("Error: Bitrix [");
    const isTemporary = /internal server error|query limit|overload|too many/i.test(text);
    if ((isBitrixError && !isTemporary) || attempt >= MAX_ATTEMPTS) throw err;
    await new Promise((r) => setTimeout(r, 500 * 2 ** (attempt - 1)));
    return bitrix(method, params, attempt + 1);
  }
}

function toIso(raw: unknown): string | null {
  if (!raw) return null;
  const d = new Date(String(raw));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

function num(raw: unknown): number | null {
  if (raw === null || raw === undefined || raw === "") return null;
  const n = Number(raw);
  return isNaN(n) ? null : n;
}

// Два элемента смарт-процесса живут среди агентов, но людьми не являются.
// Опознаются по названию, а не по id: id переживут пересоздание карточки
// хуже, чем название — его хотя бы видно глазами в Битриксе.
function видКарточки(title: string): string {
  const t = (title || "").toLowerCase();
  if (t.includes("не найден")) return "не найден";
  if (t.includes("без агента")) return "без агента";
  return "агент";
}

// Справочник источников: код Битрикса → название вида «agbfl-Петров».
// Префикс живёт в названии, а не в коде, поэтому без справочника вся
// агентская аналитика по префиксам не существует.
let SOURCE_CACHE: Map<string, string> | null = null;
async function sourceDict(supabase: any, state: Record<string, string>): Promise<Map<string, string>> {
  if (SOURCE_CACHE) return SOURCE_CACHE;

  // Справочник живёт в состоянии импорта сутки: он на полторы сотни строк,
  // меняется редко, а запрашивать его в начале каждого прохода значит
  // ставить весь импорт в зависимость от одного необязательного запроса.
  const cachedAt = Number(state.sources_dict_at || 0);
  if (Date.now() - cachedAt < 24 * 3600 * 1000 && state.sources_dict) {
    try {
      SOURCE_CACHE = new Map(Object.entries(JSON.parse(state.sources_dict)));
      return SOURCE_CACHE;
    } catch { /* испорченный кэш — перезапросим */ }
  }

  try {
    const src = new Map<string, string>();
    let start = 0;
    while (true) {
      const json = await bitrix("crm.status.list", {
        filter: { ENTITY_ID: "SOURCE" },
        select: ["STATUS_ID", "NAME"],
        start,
      });
      for (const s of json.result || []) src.set(String(s.STATUS_ID), s.NAME);
      if (!json.next) break;
      start = json.next;
    }
    await writeState(supabase, {
      sources_dict: JSON.stringify(Object.fromEntries(src)),
      sources_dict_at: String(Date.now()),
    });
    SOURCE_CACHE = src;
    return src;
  } catch (e) {
    console.error("справочник источников недоступен, беру сохранённый:", String(e));
    if (state.sources_dict) {
      try {
        SOURCE_CACHE = new Map(Object.entries(JSON.parse(state.sources_dict)));
        return SOURCE_CACHE;
      } catch { /* пусто */ }
    }
    SOURCE_CACHE = new Map<string, string>();
    return SOURCE_CACHE;
  }
}

async function readState(supabase: any): Promise<Record<string, string>> {
  const { data } = await supabase.from("agent_sync_state").select("key, value");
  const out: Record<string, string> = {};
  for (const row of data || []) out[row.key] = row.value;
  return out;
}

async function writeState(supabase: any, patch: Record<string, string>) {
  const rows = Object.entries(patch).map(([key, value]) => ({
    key, value, updated_at: new Date().toISOString(),
  }));
  if (rows.length) await supabase.from("agent_sync_state").upsert(rows, { onConflict: "key" });
}

async function upsertChunked(supabase: any, table: string, rows: any[], onConflict: string) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + 500), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const startedAt = Date.now();
  const timeLeft = () => TIME_BUDGET_MS - (Date.now() - startedAt);

  try {
    const body = await req.json().catch(() => ({}));
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const state = await readState(supabase);
    const reset = body.reset === true;

    let phase = reset ? "agents" : (state.phase || "agents");
    let start = reset ? 0 : Number(state.start || 0);
    // Отметка начала цикла. По ней в конце вычищаются строки, которые
    // больше не привязаны к агентам.
    const началоЦикла = reset || (phase === "agents" && start === 0);
    const runAt = началоЦикла
      ? new Date().toISOString()
      : (state.run_at || new Date().toISOString());

    let agentsUpserted = 0, historyUpserted = 0, leadsUpserted = 0, dealsUpserted = 0;
    let removed = 0;
    let done = false;

    if (reset) await writeState(supabase, { phase: "agents", start: "0", run_at: runAt });

    // --- Фаза 1: карточки агентов -------------------------------------------
    if (phase === "agents") {
      while (timeLeft() > 8000) {
        const json = await bitrix("crm.item.list", {
          entityTypeId: AGENT_ENTITY_TYPE,
          select: ["id", "title", "stageId", "createdTime"],
          start,
        });
        const items = json.result?.items || [];
        if (items.length) {
          await upsertChunked(supabase, "agent_cards", items.map((i: any) => ({
            agent_id: Number(i.id),
            title: i.title ?? null,
            stage_id: i.stageId ?? null,
            created_time: toIso(i.createdTime),
            вид: видКарточки(i.title),
            synced_at: new Date().toISOString(),
          })), "agent_id");
          agentsUpserted += items.length;
        }
        if (json.next === undefined || json.next === null) {
          phase = "history"; start = 0;
          await writeState(supabase, { phase, start: "0", run_at: runAt });
          break;
        }
        start = json.next;
        await writeState(supabase, { start: String(start), run_at: runAt });
      }
    }

    // --- Фаза 2: история переходов ------------------------------------------
    //
    // Запись истории — это ВХОД на стадию. Выход считается уже в базе: он
    // равен входу того же агента на следующую стадию. Хранить выходы
    // отдельной строкой нельзя — их в Битриксе просто нет.
    if (phase === "history") {
      while (timeLeft() > 8000) {
        const json = await bitrix("crm.stagehistory.list", {
          entityTypeId: AGENT_ENTITY_TYPE,
          order: { ID: "ASC" },
          start,
        });
        const items = json.result?.items || [];
        if (items.length) {
          await upsertChunked(supabase, "agent_stage_events", items.map((h: any) => ({
            event_id: Number(h.ID),
            agent_id: Number(h.OWNER_ID),
            stage_id: String(h.STAGE_ID || ""),
            created_time: toIso(h.CREATED_TIME),
          })), "event_id");
          historyUpserted += items.length;
        }
        if (json.next === undefined || json.next === null) {
          phase = "leads"; start = 0;
          await writeState(supabase, { phase, start: "0", run_at: runAt });
          break;
        }
        start = json.next;
        await writeState(supabase, { start: String(start), run_at: runAt });
      }
    }

    // --- Фаза 3: лиды агентов -----------------------------------------------
    if (phase === "leads") {
      const src = await sourceDict(supabase, state);
      while (timeLeft() > 8000) {
        const json = await bitrix("crm.lead.list", {
          filter: { [`!${AGENT_LINK_FIELD}`]: null },
          select: ["ID", "SOURCE_ID", "DATE_CREATE", "STATUS_ID", LEAD_QUAL_FIELD, AGENT_LINK_FIELD],
          order: { ID: "ASC" },
          start,
        });
        const items = json.result || [];
        if (items.length) {
          await upsertChunked(supabase, "agent_leads", items.map((l: any) => ({
            lead_id: Number(l.ID),
            agent_id: num(l[AGENT_LINK_FIELD]),
            source_marker: src.get(String(l.SOURCE_ID || "")) ?? null,
            created_at: toIso(l.DATE_CREATE),
            qualified_at: toIso(l[LEAD_QUAL_FIELD]),
            status_id: l.STATUS_ID ?? null,
            synced_at: new Date().toISOString(),
          })), "lead_id");
          leadsUpserted += items.length;
        }
        if (json.next === undefined || json.next === null) {
          phase = "deals"; start = 0;
          await writeState(supabase, { phase, start: "0", run_at: runAt });
          break;
        }
        start = json.next;
        await writeState(supabase, { start: String(start), run_at: runAt });
      }
    }

    // --- Фаза 4: сделки агентов ---------------------------------------------
    if (phase === "deals") {
      const src = await sourceDict(supabase, state);
      while (timeLeft() > 8000) {
        const json = await bitrix("crm.deal.list", {
          filter: { [`!${AGENT_LINK_FIELD}`]: null },
          select: ["ID", "CATEGORY_ID", "SOURCE_ID", "OPPORTUNITY", "STAGE_ID",
                   "DATE_CREATE", DEAL_PAID_FIELD, AGENT_LINK_FIELD],
          order: { ID: "ASC" },
          start,
        });
        const items = json.result || [];
        if (items.length) {
          await upsertChunked(supabase, "agent_deals", items.map((d: any) => ({
            deal_id: Number(d.ID),
            agent_id: num(d[AGENT_LINK_FIELD]),
            category_id: num(d.CATEGORY_ID),
            source_marker: src.get(String(d.SOURCE_ID || "")) ?? null,
            stage_id: d.STAGE_ID ?? null,
            opportunity: num(d.OPPORTUNITY),
            paid_at: toIso(d[DEAL_PAID_FIELD]),
            created_at: toIso(d.DATE_CREATE),
            synced_at: new Date().toISOString(),
          })), "deal_id");
          dealsUpserted += items.length;
        }
        if (json.next === undefined || json.next === null) {
          done = true;
          break;
        }
        start = json.next;
        await writeState(supabase, { start: String(start), run_at: runAt });
      }
    }

    // --- Уборка после полного цикла -----------------------------------------
    //
    // Всё, чего Битрикс в этом цикле не отдал, больше не привязано к агенту:
    // у лида сняли поле, карточку агента удалили. Без уборки такие строки
    // остались бы в статистике навсегда, и агент продолжал бы «приводить»
    // лиды, которых у него нет.
    if (done) {
      for (const table of ["agent_cards", "agent_leads", "agent_deals"]) {
        const { count } = await supabase.from(table)
          .delete({ count: "exact" }).lt("synced_at", runAt);
        removed += count || 0;
      }
      await writeState(supabase, {
        phase: "agents", start: "0",
        last_full_run_at: new Date().toISOString(),
      });
    }

    return new Response(JSON.stringify({
      success: true,
      done,
      phase,
      start,
      agents_upserted: agentsUpserted,
      history_upserted: historyUpserted,
      leads_upserted: leadsUpserted,
      deals_upserted: dealsUpserted,
      removed,
      elapsed_ms: Date.now() - startedAt,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("agents-import error:", String(err));
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
