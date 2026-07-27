import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

const BITRIX_WEBHOOK = "https://stopdolg.bitrix24.ru/rest/2708/krxomqqp0tb1b0jc";
const FIELD_QUALIFIED_DATE = "UF_CRM_DATETIME_KVAL_LIDA_KL";

// ИСПРАВЛЕНО: сделки фильтруем НЕ по текущей стадии (сделка могла уйти дальше по воронке),
// а по факту наличия и дате спец. поля "дата входа в стадию оплаты".
// Подтверждено на реальной сделке ID 185194: STAGE_ID уже "C34:WON", но это поле
// содержит верную историческую дату входа в оплату — 2026-07-06T13:48:36+03:00.
const DEAL_PAID_DATE_FIELD = "UF_CRM_1744372636";
const DEAL_CATEGORY_ID = 34;

const MEETING_ENTITY_TYPE_ID = 1044;
const MEETING_STAGE_SUCCESS = "DT1044_64:SUCCESS";

// Дубли — лиды, которые Битрикс автоматически переводит на этап "Дубль" в
// воронке лидов (в момент создания, поэтому дата дубля = дата создания лида,
// без отдельного датового поля). Название стадии ищем по NAME через
// crm.status.list, а не хардкодим STATUS_ID, т.к. коды у кастомных статусов
// в разных аккаунтах Битрикса разные.
const DUPLICATE_STATUS_NAME = "Дубль";

const LEADS_LOOKBACK_IDS = 5000;

// ИСПРАВЛЕНО (docs/TZ.md, диагностика расхождения квалов): раньше квалы искались
// тем же окном по ID лидов (последние 5000), что и лиды — лид, квалифицированный
// на этой неделе, но созданный больше ~5000 ID назад (например месяц назад),
// молча выпадал из выборки. Подтверждено на практике: 3 лида созданы в прошлом
// месяце, отквалились на этой неделе — не попадали в daily_facts.
// Теперь квалы ищутся прямой фильтрацией crm.lead.list по самому полю даты
// квалификации (FIELD_QUALIFIED_DATE), без привязки к ID вообще.
const QUAL_SAFETY_CAP = 5000; // предохранитель на случай, если фильтр Bitrix по этому полю не сработает

// ИСПРАВЛЕНО: та же болезнь, что была у квалов — сделки искались окном по ID
// (последние 3000), а не по дате. Подтверждено на практике: сделка ID 158348,
// оплаченная на 29 неделе, не попадала в daily_facts, потому что к моменту
// импорта её ID оказался дальше чем 3000 назад от текущего максимума —
// окно по ID её просто не захватывало, независимо от даты оплаты.
// Теперь сделки ищутся прямой фильтрацией crm.deal.list по самому полю даты
// оплаты (DEAL_PAID_DATE_FIELD), без привязки к ID вообще — как и квалы.
const DEAL_SAFETY_CAP = 5000; // предохранитель на случай, если фильтр Bitrix по этому полю не сработает

const SUPABASE_URL = Deno.env.get("SUPABASE_URL")!;
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function getWeekStartForDate(date: Date): string {
  const day = date.getDay();
  const diff = day >= 4 ? day - 4 : day + 3;
  const d = new Date(date);
  d.setDate(date.getDate() - diff);
  return d.toISOString().split("T")[0];
}

function addDays(dateStr: string, n: number): string {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + n);
  return d.toISOString().split("T")[0];
}

async function bitrixCall(method: string, params: Record<string, any>) {
  const url = `${BITRIX_WEBHOOK}/${method}.json`;
  const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(params) });
  const json = await res.json();
  if (json.error) throw new Error(`Bitrix error [${method}]: ${json.error_description || json.error}`);
  return json;
}

async function getCurrentMaxId(method: string, filter: Record<string, any>, idField = "ID"): Promise<number> {
  const json = await bitrixCall(method, { filter, order: { [idField]: "DESC" }, select: [idField], start: 0 });
  const items: any[] = json.result || [];
  return items.length ? Number(items[0][idField]) : 0;
}

async function bitrixListSinceId(method: string, params: Record<string, any>, fromId: number, idField: string = "ID"): Promise<any[]> {
  const items: any[] = [];
  let start = 0;
  while (true) {
    const json = await bitrixCall(method, { ...params, filter: { ...params.filter, [`>${idField}`]: fromId }, order: { [idField]: "ASC" }, start });
    const page: any[] = json.result || [];
    if (page.length === 0) break;
    items.push(...page);
    if (!json.next) break;
    start = json.next;
  }
  return items;
}

async function bitrixListAllPages(method: string, params: Record<string, any>, resultKey?: string): Promise<any[]> {
  const items: any[] = [];
  let start = 0;
  while (true) {
    const json = await bitrixCall(method, { ...params, start });
    const page: any[] = resultKey ? (json.result?.[resultKey] || []) : (json.result || []);
    if (page.length === 0) break;
    items.push(...page);
    if (!json.next) break;
    start = json.next;
  }
  return items;
}

// Прямая фильтрация по датовому полю (без привязки к ID) — с предохранителем:
// если Bitrix проигнорирует фильтр (как это подтверждено для системного DATE_CREATE)
// и начнёт отдавать вообще всё подряд, останавливаемся на safetyCap записях и
// сигнализируем об этом наружу через filterLikelyBroken, а не виснем на 150 секундах.
async function bitrixListByDateField(
  method: string,
  params: Record<string, any>,
  dateField: string,
  dateFromInclusive: string,
  dateToExclusive: string,
  safetyCap: number,
): Promise<{ items: any[]; filterLikelyBroken: boolean }> {
  const items: any[] = [];
  let start = 0;
  let filterLikelyBroken = false;
  while (true) {
    const json = await bitrixCall(method, {
      ...params,
      filter: { ...params.filter, [`>=${dateField}`]: dateFromInclusive, [`<${dateField}`]: dateToExclusive },
      order: { ID: "ASC" },
      start,
    });
    const page: any[] = json.result || [];
    if (page.length === 0) break;
    items.push(...page);
    if (items.length >= safetyCap) {
      filterLikelyBroken = true;
      console.warn(`bitrixListByDateField: hit safety cap of ${safetyCap} for ${method}.${dateField} — filter may not be working, falling back is recommended`);
      break;
    }
    if (!json.next) break;
    start = json.next;
  }
  return { items, filterLikelyBroken };
}

// Находит STATUS_ID лидового статуса по отображаемому имени (ENTITY_ID
// "STATUS" — это как раз статусы/стадии воронки лидов в Битриксе).
async function findLeadStatusId(name: string): Promise<string | null> {
  let start = 0;
  while (true) {
    const json = await bitrixCall("crm.status.list", { filter: { ENTITY_ID: "STATUS" }, select: ["STATUS_ID", "NAME"], start });
    const page: any[] = json.result || [];
    const found = page.find((s: any) => s.NAME === name);
    if (found) return String(found.STATUS_ID);
    if (!json.next) break;
    start = json.next;
  }
  return null;
}

async function buildSourceMap(): Promise<Map<string, string>> {
  const all: any[] = [];
  let start = 0;
  while (true) {
    const json = await bitrixCall("crm.status.list", { filter: { ENTITY_ID: "SOURCE" }, select: ["STATUS_ID", "NAME"], start });
    all.push(...(json.result || []));
    if (!json.next) break;
    start = json.next;
  }
  const map = new Map<string, string>();
  for (const s of all) if (s.NAME?.startsWith("ofbfl-")) map.set(String(s.STATUS_ID), s.NAME);
  return map;
}

function groupBySourceName(items: any[], sourceIdField: string, sourceMap: Map<string, string>) {
  const result: Record<string, number> = {};
  for (const item of items) {
    const name = sourceMap.get(String(item[sourceIdField] || ""));
    if (!name) continue;
    result[name] = (result[name] || 0) + 1;
  }
  return result;
}

// Как groupBySourceName, но суммирует числовое поле (OPPORTUNITY сделки) вместо счётчика.
function sumBySourceName(items: any[], sourceIdField: string, valueField: string, sourceMap: Map<string, string>) {
  const result: Record<string, number> = {};
  for (const item of items) {
    const name = sourceMap.get(String(item[sourceIdField] || ""));
    if (!name) continue;
    result[name] = (result[name] || 0) + (Number(item[valueField]) || 0);
  }
  return result;
}

function toDateMsk(isoStr: string): string {
  if (!isoStr) return "";
  const msk = new Date(new Date(isoStr).getTime() + 3 * 60 * 60 * 1000);
  return msk.toISOString().split("T")[0];
}

console.info("server started");

Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    const body = await req.json().catch(() => ({}));
    const targetDate: string = body.date || (() => {
      const d = new Date();
      d.setDate(d.getDate() - 1);
      return d.toISOString().split("T")[0];
    })();

    const today = new Date();
    const currentWeekStart = getWeekStartForDate(today);
    const targetWeekStart = getWeekStartForDate(new Date(targetDate + "T12:00:00"));

    const isThursday = today.getDay() === 4 && getWeekStartForDate(today) === today.toISOString().split("T")[0];
    const previousWeekStart = addDays(currentWeekStart, -7);
    const isAllowed = targetWeekStart === currentWeekStart || (isThursday && targetWeekStart === previousWeekStart);

    if (!isAllowed) {
      return new Response(JSON.stringify({
        success: false,
        error: `Дата ${targetDate} недоступна для импорта. Разрешена текущая неделя (${currentWeekStart}), а по четвергам — ещё и предыдущая (${previousWeekStart}).`,
      }), { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);
    const sourceMap = await buildSourceMap();
    const duplicateStatusId = await findLeadStatusId(DUPLICATE_STATUS_NAME);
    if (!duplicateStatusId) {
      console.warn(`findLeadStatusId: не нашли статус лида с именем "${DUPLICATE_STATUS_NAME}" — дубли будут считаться нулями до исправления`);
    }

    const leadsMaxId = await getCurrentMaxId("crm.lead.list", {});
    const leadsFromId = Math.max(0, leadsMaxId - LEADS_LOOKBACK_IDS);

    const qualDateFromMsk = `${targetDate}T00:00:00+03:00`;
    const qualDateToMsk = `${addDays(targetDate, 1)}T00:00:00+03:00`;
    const dealDateFromMsk = qualDateFromMsk;
    const dealDateToMsk = qualDateToMsk;

    const [leadsPool, qualsResult, dealsResult, meetingsRaw] = await Promise.all([
      bitrixListSinceId("crm.lead.list", { select: ["ID", "SOURCE_ID", "DATE_CREATE", "STATUS_ID"] }, leadsFromId),
      // Квалы — прямая фильтрация по дате квалификации, без окна по ID (см. комментарий у QUAL_SAFETY_CAP).
      bitrixListByDateField("crm.lead.list", { select: ["ID", "SOURCE_ID", FIELD_QUALIFIED_DATE] }, FIELD_QUALIFIED_DATE, qualDateFromMsk, qualDateToMsk, QUAL_SAFETY_CAP),
      // Сделки: только по воронке (CATEGORY_ID), БЕЗ фильтра по стадии — прямая
      // фильтрация по дате оплаты, без окна по ID (см. комментарий у DEAL_SAFETY_CAP).
      bitrixListByDateField(
        "crm.deal.list",
        { filter: { CATEGORY_ID: DEAL_CATEGORY_ID }, select: ["ID", "SOURCE_ID", DEAL_PAID_DATE_FIELD, "OPPORTUNITY"] },
        DEAL_PAID_DATE_FIELD,
        dealDateFromMsk,
        dealDateToMsk,
        DEAL_SAFETY_CAP,
      ),
      // ИСПРАВЛЕНО: раньше тянули только ПЕРВУЮ страницу (до 50 записей) отсортированную по id —
      // встреча, созданная давно но проведённая на этой неделе, могла не попасть в топ-50 по id
      // и молча теряться. Теперь листаем ВСЕ страницы, как для лидов/квалов/сделок.
      bitrixListAllPages("crm.item.list", {
        entityTypeId: MEETING_ENTITY_TYPE_ID,
        filter: { stageId: MEETING_STAGE_SUCCESS },
        select: ["id", "sourceId", "closedate"],
        order: { id: "DESC" },
      }, "items").catch((e) => {
        console.error("Meetings query failed:", e);
        return [];
      }),
    ]);

    const qualsPool = qualsResult.items;
    const dealsPool = dealsResult.items;

    const leadsForDay = leadsPool.filter(i => toDateMsk(i.DATE_CREATE) === targetDate);
    // Клиентская проверка даты остаётся как страховка даже при серверной фильтрации —
    // если Bitrix вернул лишнее (или пограничные записи по времени), отсекаем здесь.
    const qualsForDay = qualsPool.filter(i => {
      const qDate = i[FIELD_QUALIFIED_DATE];
      return qDate && toDateMsk(qDate) === targetDate;
    });
    // Сделка считается "оплаченной в этот день" если поле заполнено И дата совпадает —
    // независимо от того, на какой стадии сделка находится СЕЙЧАС
    const dealsForDay = dealsPool.filter(i => {
      const pDate = i[DEAL_PAID_DATE_FIELD];
      return pDate && toDateMsk(pDate) === targetDate;
    });
    const meetingsForDay = meetingsRaw.filter((m: any) => toDateMsk(m.closedate) === targetDate);
    // Дубль определяется автоматически при создании лида — дата совпадает с
    // DATE_CREATE, поэтому берём дубли прямо из leadsForDay, без отдельного запроса.
    const duplicatesForDay = duplicateStatusId ? leadsForDay.filter(i => String(i.STATUS_ID) === duplicateStatusId) : [];

    console.info(`For ${targetDate}: leads=${leadsForDay.length}, quals=${qualsForDay.length} (pool=${qualsPool.length}, filterLikelyBroken=${qualsResult.filterLikelyBroken}), deals=${dealsForDay.length} (pool=${dealsPool.length}, filterLikelyBroken=${dealsResult.filterLikelyBroken}), meetings=${meetingsForDay.length}, duplicates=${duplicatesForDay.length}`);

    const leadsBySource = groupBySourceName(leadsForDay, "SOURCE_ID", sourceMap);
    const qualsBySource = groupBySourceName(qualsForDay, "SOURCE_ID", sourceMap);
    const dealsBySource = groupBySourceName(dealsForDay, "SOURCE_ID", sourceMap);
    const meetingsBySource = groupBySourceName(meetingsForDay, "sourceId", sourceMap);
    const duplicatesBySource = groupBySourceName(duplicatesForDay, "SOURCE_ID", sourceMap);
    // Revenue = сумма OPPORTUNITY сделок, оплаченных в этот день (тот же набор dealsForDay).
    const revenueBySource = sumBySourceName(dealsForDay, "SOURCE_ID", "OPPORTUNITY", sourceMap);

    const allSources = new Set([...Object.keys(leadsBySource), ...Object.keys(qualsBySource), ...Object.keys(dealsBySource), ...Object.keys(meetingsBySource)]);

    const { data: allDbSources } = await supabase.from("sources").select("id, contractor_id, roistat_marker");
    const dbSourceMap = new Map<string, { id: string; contractor_id: string; realName: string }>();
    for (const s of allDbSources || []) {
      if (s.roistat_marker) dbSourceMap.set(s.roistat_marker.toLowerCase(), { id: s.id, contractor_id: s.contractor_id, realName: s.roistat_marker });
    }

    const results: any[] = [];
    const unmatched: string[] = [];

    // ВАЖНО: перед записью свежих данных обнуляем ВСЕ источники, которые ранее уже
    // фигурировали в daily_facts за этот день. Иначе если источник выпал из текущего
    // расчёта (например раньше был баг и дал ложную сделку/лид, а сейчас корректно 0),
    // старая запись останется висеть вечно — upsert трогает только совпавшие строки.
    const { data: existingRows } = await supabase
      .from("daily_facts")
      .select("source_marker")
      .eq("fact_date", targetDate);

    for (const row of existingRows || []) {
      if (!allSources.has(row.source_marker)) {
        await supabase.from("daily_facts").upsert({
          fact_date: targetDate,
          source_marker: row.source_marker,
          leads: 0, quals: 0, meetings: 0, deals: 0, revenue: 0, duplicates: 0,
        }, { onConflict: "fact_date,source_marker" });
      }
    }

    for (const sourceName of allSources) {
      const leadsCount = leadsBySource[sourceName] || 0;
      const qualsCount = qualsBySource[sourceName] || 0;
      const dealsCount = dealsBySource[sourceName] || 0;
      const meetingsCount = meetingsBySource[sourceName] || 0;
      const revenueSum = revenueBySource[sourceName] || 0;
      const duplicatesCount = duplicatesBySource[sourceName] || 0;
      const matched = dbSourceMap.get(sourceName.toLowerCase());

      if (!matched) {
        unmatched.push(sourceName);
        const { data: ex } = await supabase.from("unmatched_sources").select("id, total_leads").eq("source_marker", sourceName).maybeSingle();
        if (ex) {
          await supabase.from("unmatched_sources").update({ last_seen_at: new Date().toISOString(), total_leads: (ex.total_leads || 0) + leadsCount }).eq("id", ex.id);
        } else {
          await supabase.from("unmatched_sources").insert({ source_marker: sourceName, total_leads: leadsCount });
        }
      }

      await supabase.from("daily_facts").upsert({
        fact_date: targetDate,
        source_marker: sourceName,
        contractor_id: matched?.contractor_id || null,
        source_id: matched?.id || null,
        leads: leadsCount, quals: qualsCount, meetings: meetingsCount, deals: dealsCount, revenue: revenueSum, duplicates: duplicatesCount,
      }, { onConflict: "fact_date,source_marker" });

      results.push({ source: sourceName, matched: !!matched, leads: leadsCount, quals: qualsCount, meetings: meetingsCount, deals: dealsCount, revenue: revenueSum, duplicates: duplicatesCount });
    }

    return new Response(JSON.stringify({
      success: true, date: targetDate, week_start: targetWeekStart,
      leads_for_day: leadsForDay.length, quals_for_day: qualsForDay.length, deals_for_day: dealsForDay.length, meetings_for_day: meetingsForDay.length,
      duplicates_for_day: duplicatesForDay.length,
      duplicate_status_found: !!duplicateStatusId,
      quals_filter_likely_broken: qualsResult.filterLikelyBroken,
      deals_filter_likely_broken: dealsResult.filterLikelyBroken,
      processed: results, unmatched_sources: unmatched,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("Import error:", String(err));
    return new Response(JSON.stringify({ success: false, error: String(err) }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
  }
});
