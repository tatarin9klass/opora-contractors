import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// Импорт сделок воронки «Продажа БФЛ» для кабинета РОПа.
//
// ЗАЧЕМ ОТДЕЛЬНАЯ ФУНКЦИЯ. bitrix-import считает дневные агрегаты и работает
// по узкому окну дат; этому нужен построчный проход с товарными позициями и
// историей стадий. Смешивать их — значит рисковать ежедневным импортом ради
// нового экрана.
//
// ТРИ ФАЗЫ, КАЖДАЯ СО СВОИМ КУРСОРОМ:
//
//   deals    — сами сделки постранично, плюс источник из лида-родителя;
//   products — товарные позиции, запрос на сделку;
//   stages   — история переходов, тоже запрос на сделку.
//
// ПОЧЕМУ ФАЗЫ, А НЕ ОДИН ПРОХОД. Позиции и история берутся поштучно: на 600
// сделок это 1200 запросов в Битрикс, в один вызов функции они не умещаются
// по времени. Каждая фаза продолжается с сохранённой позиции, и кнопка в
// приложении добивает их по кругу — ровно как сделано в bfl-timings.
//
// ИСТОЧНИК БЕРЁТСЯ ИЗ ЛИДА, НО ЛИДЫ НЕ ИМПОРТИРУЮТСЯ. РОПу нужна развёртка
// на маркетинг и рекомендации, то есть префикс источника. Он есть у лида-
// родителя, и соблазн велик — затащить все лиды с префиксами OP, R и agbfl
// в bfl_lead_timings. Этого делать НЕЛЬЗЯ: на той таблице стоит весь
// управленческий учёт направления, который считает только ofbfl, и появление
// чужих строк тихо испортит каждую его цифру. Поэтому источник забирается
// пачками по ID лидов и кладётся прямо в строку сделки.
// ============================================================================

const BITRIX_WEBHOOK = "https://stopdolg.bitrix24.ru/rest/2708/krxomqqp0tb1b0jc";

const CATEGORY_ID = 34;            // воронка «Продажа БФЛ»
const DEALS_FROM = "2026-09-01";   // глубина истории — по решению руководителя

const TIME_BUDGET_MS = 90_000;

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

// Повторы обязательны, а не предосторожность. Связь между Supabase и
// Битриксом рвётся регулярно — наблюдали «http2 error: connection error»
// посреди прохода. Один такой разрыв без повторов роняет весь проход, и
// полторы минуты работы уходят впустую.
//
// Повторяем только сетевые сбои. Ошибку самого Битрикса (нет прав, неверный
// метод) повторять бессмысленно: она не исчезнет, а время съест.
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
    // «Internal server error» и ограничение частоты — временные: Битрикс
    // отвечает так под нагрузкой, через секунду тот же запрос проходит.
    // Остальные его ошибки (нет прав, неверный метод) повторять незачем.
    const isTemporary = /internal server error|query limit|overload|too many/i.test(text);
    if ((isBitrixError && !isTemporary) || attempt >= MAX_ATTEMPTS) throw err;
    // 0,5 · 1 · 2 секунды — достаточно, чтобы пережить обрыв, и достаточно
    // мало, чтобы не съесть бюджет времени прохода.
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

// Названия стадий воронки. Берём из Битрикса, а не держим списком: стадии
// переименовывают, и захардкоженный список разъедется молча.
// Справочник стадий. Запрашивается раз в сутки и кладётся в состояние
// импорта: он меняется редко, а дёргать его в начале каждого прохода —
// значит ставить весь импорт в зависимость от одного необязательного
// запроса. Именно на нём импорт и встал: Битрикс ответил «Internal server
// error», и проход упал, не начавшись.
async function stageNames(supabase: any, state: Record<string, string>): Promise<Map<string, string>> {
  const cachedAt = Number(state.stages_dict_at || 0);
  const fresh = Date.now() - cachedAt < 24 * 3600 * 1000;
  if (fresh && state.stages_dict) {
    try {
      return new Map(Object.entries(JSON.parse(state.stages_dict)));
    } catch { /* испорченный кэш — просто перезапросим */ }
  }

  try {
    const map = new Map<string, string>();
    const json = await bitrix("crm.status.list", {
      filter: { ENTITY_ID: `DEAL_STAGE_${CATEGORY_ID}` },
      select: ["STATUS_ID", "NAME"],
    });
    for (const s of json.result || []) map.set(String(s.STATUS_ID), s.NAME);
    await writeState(supabase, {
      stages_dict: JSON.stringify(Object.fromEntries(map)),
      stages_dict_at: String(Date.now()),
    });
    return map;
  } catch (e) {
    // Не смогли обновить — работаем на прежнем справочнике. Названия стадий
    // нужны для удобства чтения, а не для расчётов: те идут по stage_id.
    console.error("crm.status.list недоступен, беру сохранённый справочник:", String(e));
    if (state.stages_dict) {
      try { return new Map(Object.entries(JSON.parse(state.stages_dict))); } catch { /* пусто */ }
    }
    return new Map<string, string>();
  }
}

async function userNames(ids: number[]): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  for (const id of [...new Set(ids)]) {
    if (!id) continue;
    try {
      const u = (await bitrix("user.get", { ID: id })).result?.[0];
      const name = [u?.LAST_NAME, u?.NAME].filter(Boolean).join(" ").trim();
      map.set(String(id), name || `id ${id}`);
    } catch {
      // Прав на user.get может не быть. Без фамилии экран по менеджерам
      // будет бесполезен, но валить из-за этого весь импорт незачем.
      map.set(String(id), `id ${id}`);
    }
  }
  return map;
}

// Источники лидов пачками. Названия нужны целиком — группа (маркетинг или
// рекомендации) считается уже в базе, по справочнику префиксов.
// Справочник источников лидов. Тянется один раз за вызов функции: он на
// полторы сотни строк и на каждой странице сделок заново не нужен.
let SOURCE_CACHE: Map<string, string> | null = null;
async function sourceDict(supabase: any, state: Record<string, string>): Promise<Map<string, string>> {
  if (SOURCE_CACHE) return SOURCE_CACHE;

  // Тот же приём, что и со стадиями: справочник источников живёт в
  // состоянии импорта сутки. Он на полторы сотни строк, меняется редко, а
  // на каждом проходе ставит фазу сделок в зависимость от одного запроса,
  // который Битрикс периодически отдаёт с ошибкой.
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

async function leadSources(supabase: any, state: Record<string, string>, leadIds: number[]): Promise<Map<number, string>> {
  const out = new Map<number, string>();
  const ids = [...new Set(leadIds.filter(Boolean))];
  if (!ids.length) return out;
  const src = await sourceDict(supabase, state);

  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const json = await bitrix("crm.lead.list", {
      filter: { ID: chunk },
      select: ["ID", "SOURCE_ID"],
      start: 0,
    });
    for (const l of json.result || []) {
      const name = src.get(String(l.SOURCE_ID || "")) ?? null;
      if (name) out.set(Number(l.ID), name);
    }
  }
  return out;
}

async function readState(supabase: any): Promise<Record<string, string>> {
  const { data } = await supabase.from("rop_sync_state").select("key, value");
  const out: Record<string, string> = {};
  for (const row of data || []) out[row.key] = row.value;
  return out;
}

async function writeState(supabase: any, patch: Record<string, string>) {
  const rows = Object.entries(patch).map(([key, value]) => ({
    key, value, updated_at: new Date().toISOString(),
  }));
  if (rows.length) await supabase.from("rop_sync_state").upsert(rows, { onConflict: "key" });
}

async function upsertChunked(supabase: any, table: string, rows: any[], onConflict: string) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from(table).upsert(rows.slice(i, i + 500), { onConflict });
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

// Позиции и история — строки без собственного ключа: он выдаётся базой.
// Upsert по id здесь не годится, его просто нет в данных.
async function insertChunked(supabase: any, table: string, rows: any[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await supabase.from(table).insert(rows.slice(i, i + 500));
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

    let phase = body.reset ? "deals" : (state.phase || "deals");
    let dealsStart = body.reset ? 0 : Number(state.deals_start || 0);
    let productsDone = body.reset ? 0 : Number(state.products_done || 0);
    let stagesDone = body.reset ? 0 : Number(state.stages_done || 0);

    // Новый цикл начинается с начала: стадия, сумма и состав услуг меняются
    // всю жизнь сделки, поэтому догружать только новые нельзя — иначе
    // воронка навсегда застынет в том виде, в каком сделку увидели впервые.
    if (phase === "" || phase === "idle" || body.reset) {
      phase = "deals";
      dealsStart = 0;
      productsDone = 0;
      stagesDone = 0;
      await writeState(supabase, {
        phase, deals_start: "0", products_done: "0", stages_done: "0",
      });
    }

    const stages = await stageNames(supabase, state);
    let dealsUpserted = 0, productsUpserted = 0, stagesUpserted = 0;
    let done = false;

    // --- фаза 1: сделки ----------------------------------------------------
    //
    // ДВА ПРОХОДА, И ВТОРОЙ ВАЖНЕЕ ПЕРВОГО ДЛЯ ПОРТФЕЛЯ.
    //
    // Первый тянет всё, что создано в окне истории: по этим сделкам живёт
    // поток — встречи, брак, передачи, средний чек.
    //
    // Второй тянет ВСЕ ОТКРЫТЫЕ сделки воронки, сколько бы им ни было лет.
    // Без него портфель обрезан по дате: на день проверки из 299 открытых
    // сделок 98 были созданы до начала окна — треть запаса, которой мы не
    // видели. А запас как раз и состоит из того, что висит давно.
    //
    // Закрытые при этом остаются ограничены окном: тянуть их целиком
    // значило бы каждый раз перечитывать всю историю воронки за годы ради
    // сделок, которые больше не изменятся.
    while ((phase === "deals" || phase === "deals_open") && timeLeft() > 12_000) {
      const json = await bitrix("crm.deal.list", {
        filter: phase === "deals"
          ? { CATEGORY_ID, ">=DATE_CREATE": `${DEALS_FROM}T00:00:00+03:00` }
          : { CATEGORY_ID, CLOSED: "N" },
        select: [
          "ID", "TITLE", "CATEGORY_ID", "STAGE_ID", "OPPORTUNITY", "CLOSED",
          "ASSIGNED_BY_ID", "LEAD_ID", "SOURCE_ID",
          "DATE_CREATE", "CLOSEDATE", "MOVED_TIME",
        ],
        order: { ID: "ASC" },
        start: dealsStart,
      });
      const page: any[] = json.result || [];
      if (page.length === 0) {
        phase = phase === "deals" ? "deals_open" : "products";
        dealsStart = 0;
        await writeState(supabase, { phase, deals_start: "0", products_done: "0" });
        break;
      }

      const users = await userNames(page.map((d) => Number(d.ASSIGNED_BY_ID)));
      const srcByLead = await leadSources(supabase, state, page.map((d) => Number(d.LEAD_ID)));
      const srcDict = await sourceDict(supabase, state);

      // Источник: сперва из лида-родителя — так считает весь остальной учёт
      // направления. Если лида нет, берём собственное поле сделки: сделок
      // без источника в компании не бывает, и пустая колонка означала бы
      // не отсутствие данных, а то, что мы не там посмотрели.
      const sourceOf = (d: any): { name: string | null; id: string | null; from: string | null } => {
        const leadId = Number(d.LEAD_ID);
        const fromLead = leadId ? srcByLead.get(leadId) : undefined;
        if (fromLead) return { name: fromLead, id: String(d.SOURCE_ID ?? ""), from: "лид" };
        const ownId = d.SOURCE_ID ? String(d.SOURCE_ID) : null;
        if (ownId) {
          // Названия может не быть в справочнике — встречаются значения,
          // которых там нет (похоже, из коллтрекинга). Тогда пишем сам
          // идентификатор: лучше неудобное имя, чем пустота.
          return { name: srcDict.get(ownId) ?? `id ${ownId}`, id: ownId, from: "сделка" };
        }
        return { name: null, id: null, from: null };
      };

      const rows = page.map((d) => {
        const src = sourceOf(d);
        return {
        deal_id: Number(d.ID),
        title: d.TITLE ?? null,
        category_id: Number(d.CATEGORY_ID ?? CATEGORY_ID),
        stage_id: String(d.STAGE_ID || ""),
        stage_name: stages.get(String(d.STAGE_ID || "")) ?? null,
        opportunity: num(d.OPPORTUNITY),
        // Признак «сделка закрыта» берём у Битрикса, а не выводим из списка
        // стадий: список меняется, и каждая новая отказная стадия тихо
        // попадала бы в портфель как живая.
        closed: String(d.CLOSED || "N") === "Y",
        assigned_by_id: d.ASSIGNED_BY_ID ? Number(d.ASSIGNED_BY_ID) : null,
        assigned_by_name: users.get(String(d.ASSIGNED_BY_ID || "")) ?? null,
        lead_id: d.LEAD_ID ? Number(d.LEAD_ID) : null,
        source_name: src.name,
        source_id: src.id,
        source_from: src.from,
        date_create: toIso(d.DATE_CREATE),
        closedate: toIso(d.CLOSEDATE),
        moved_time: toIso(d.MOVED_TIME),
        synced_at: new Date().toISOString(),
        };
      });

      await upsertChunked(supabase, "rop_deals", rows, "deal_id");
      dealsUpserted += rows.length;

      if (!json.next) {
        phase = phase === "deals" ? "deals_open" : "products";
        dealsStart = 0;
        await writeState(supabase, { phase, deals_start: "0", products_done: "0" });
        break;
      }
      dealsStart = json.next;
      await writeState(supabase, { deals_start: String(dealsStart) });
    }

    // --- фаза 2: товарные позиции ------------------------------------------
    // Запрос на сделку, поэтому идём порциями и помним, сколько прошли.
    while (phase === "products" && timeLeft() > 12_000) {
      const { data: batch } = await supabase
        .from("rop_deals").select("deal_id")
        .order("deal_id", { ascending: true })
        .range(productsDone, productsDone + 24);

      if (!batch || batch.length === 0) {
        phase = "stages";
        await writeState(supabase, { phase, stages_done: "0" });
        break;
      }

      const rows: any[] = [];
      const ids: number[] = [];
      for (const { deal_id } of batch) {
        if (timeLeft() < 6000) break;
        ids.push(deal_id);
        const json = await bitrix("crm.deal.productrows.get", { id: deal_id });
        for (const r of json.result || []) {
          const price = num(r.PRICE) ?? 0;
          const qty = num(r.QUANTITY) ?? 1;
          rows.push({
            deal_id,
            product_name: r.PRODUCT_NAME ?? "—",
            price, quantity: qty, total: price * qty,
          });
        }
      }

      // Позиции сделки перезаписываются целиком: состав услуг меняется, и
      // дописывание оставило бы удалённые строки навсегда.
      if (ids.length) {
        await supabase.from("rop_deal_products").delete().in("deal_id", ids);
        if (rows.length) {
          await insertChunked(supabase, "rop_deal_products", rows);
          productsUpserted += rows.length;
        }
      }

      productsDone += ids.length;
      await writeState(supabase, { products_done: String(productsDone) });
      if (ids.length < batch.length) break;
    }

    // --- фаза 3: история стадий --------------------------------------------
    while (phase === "stages" && timeLeft() > 12_000) {
      const { data: batch } = await supabase
        .from("rop_deals").select("deal_id")
        .order("deal_id", { ascending: true })
        .range(stagesDone, stagesDone + 24);

      if (!batch || batch.length === 0) {
        phase = "idle";
        done = true;
        await writeState(supabase, { phase });
        break;
      }

      const rows: any[] = [];
      const ids: number[] = [];
      for (const { deal_id } of batch) {
        if (timeLeft() < 6000) break;
        ids.push(deal_id);
        const json = await bitrix("crm.stagehistory.list", {
          entityTypeId: 2,
          filter: { OWNER_ID: deal_id },
          order: { ID: "ASC" },
          start: 0,
        });
        for (const h of json.result?.items || []) {
          rows.push({
            deal_id,
            stage_id: String(h.STAGE_ID || ""),
            stage_name: stages.get(String(h.STAGE_ID || "")) ?? null,
            entered_at: toIso(h.CREATED_TIME),
          });
        }
      }

      if (ids.length) {
        await supabase.from("rop_deal_stages").delete().in("deal_id", ids);
        if (rows.length) {
          await insertChunked(supabase, "rop_deal_stages", rows);
          stagesUpserted += rows.length;
        }
      }

      stagesDone += ids.length;
      await writeState(supabase, { stages_done: String(stagesDone) });
      if (ids.length < batch.length) break;
    }

    return new Response(JSON.stringify({
      success: true,
      done,
      phase,
      deals_upserted: dealsUpserted,
      products_upserted: productsUpserted,
      stages_upserted: stagesUpserted,
      deals_start: dealsStart,
      products_done: productsDone,
      stages_done: stagesDone,
      elapsed_ms: Date.now() - startedAt,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("rop-deals error:", String(err));
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
