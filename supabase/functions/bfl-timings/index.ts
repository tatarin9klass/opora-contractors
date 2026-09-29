import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "jsr:@supabase/supabase-js@2";

// ============================================================================
// Импорт отметок времени по воронке БФЛ для вкладки «Зависимости».
//
// Отдельная функция, а не довесок к bitrix-import: тот считает дневные
// агрегаты и работает каждый день по узкому окну дат, а этому нужен разовый
// проход по истории построчно. Смешивать их — значит рисковать рабочим
// ежедневным импортом ради разовой аналитики.
//
// ЧТО ТЯНЕМ:
//   * лиды с источником ofbfl-: дата создания и дата квалификации;
//   * встречи (смарт-процесс 1044, стадия «успех»): дата проведения и ссылка
//     на лид, из которого встреча выросла.
//
// ПРО ССЫЛКУ ВСТРЕЧА → ЛИД. В смарт-процессах Битрикса родительские связи
// лежат в полях вида parentId<entityTypeId>, для лида это parentId1. Но
// настройки у всех разные, поэтому имя поля не захардкожено: функция берёт
// первую встречу, ищет у неё подходящий ключ и дальше пользуется найденным.
// Если не нашла — честно возвращает список полей встречи, и связь можно
// дописать руками, а не гадать, почему два графика из трёх пустые.
// ============================================================================

const BITRIX_WEBHOOK = "https://stopdolg.bitrix24.ru/rest/2708/krxomqqp0tb1b0jc";
const FIELD_QUALIFIED_DATE = "UF_CRM_DATETIME_KVAL_LIDA_KL";

const MEETING_ENTITY_TYPE_ID = 1044;
const MEETING_CATEGORY_ID = 64;

// Реальное время встречи. closedate для этого не годится: у него тип `date`,
// времени нет вообще (проверено на записи 214 — closedate 30.03 «полночь»,
// а встреча была в 13:00). Отсюда же брались отрицательные интервалы, когда
// квал проставлен утром, а встреча в тот же день.
const FIELD_MEETING_DATETIME = "ufCrm28Datetime";
// Техническое поле, куда БП пишет состояние встречи («Проведена» и т.п.).
// Забираем как есть, классифицировать будем по факту увиденного.
const FIELD_MEETING_STATUS = "ufCrm28_1742814152";

// Люди и отдел. По источнику задачу не поставишь, а по фамилии — можно.
const FIELD_SCHEDULED_BY = "ufCrm28_1743059683"; // кто назначил встречу
const FIELD_CONSULTED_BY = "ufCrm28_1743059728"; // кто проводил консультацию
const FIELD_MKO_DEPARTMENT = "ufCrm28_1743059876"; // отдел МКО (список)

// Значения списка «Отдел МКО» — из crm.item.fields, entityTypeId 1044.
const MKO_DEPARTMENTS: Record<string, string> = {
  "3324": "МКО 1",
  "3326": "МКО 2",
  "3328": "МКО 3",
  "4806": "ОАС",
  "4848": "Прочие",
};

// Показываем с 16 июля — с этого дня данные заводятся системно. Но лиды
// тянем с запасом назад: лид, созданный в мае и отквалившийся в августе,
// обязан попасть в замер за августовскую неделю, иначе среднее занижается
// ровно на самые долгие случаи — те, ради которых всё и затевалось.
const LEAD_MIN_DATE = "2026-04-01";
const MEETING_MIN_DATE = "2026-07-16";

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

// Битрикс отдаёт даты со смещением (+03:00) — new Date их разбирает корректно,
// в базу кладём как timestamptz, поэтому таймзона не теряется.
function toIso(raw: unknown): string | null {
  if (!raw) return null;
  const d = new Date(String(raw));
  return isNaN(d.getTime()) ? null : d.toISOString();
}

// Названия стадий воронки лидов: STATUS_ID -> NAME. Нужны, чтобы в отчётах
// было видно «Назначение встречи», а не код вида UC_XXXX, и чтобы не держать
// список стадий отдельным справочником, который разъедется с Битриксом.
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

// Сотрудники: ID -> «Фамилия Имя». Без этого в отчётах вместо людей стояли бы
// числовые идентификаторы, по которым никому ничего не понятно.
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

async function buildSourceMap(): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let start = 0;
  while (true) {
    const json = await bitrixCall("crm.status.list", {
      filter: { ENTITY_ID: "SOURCE" },
      select: ["STATUS_ID", "NAME"],
      start,
    });
    for (const s of json.result || []) {
      if (s.NAME?.startsWith("ofbfl-")) map.set(String(s.STATUS_ID), s.NAME);
    }
    if (!json.next) break;
    start = json.next;
  }
  return map;
}

// parentId1 — стандартное имя поля «родительский лид» у смарт-процесса.
// Проверяем ещё и leadId на случай нестандартной настройки.
function detectLeadField(item: Record<string, unknown>): string | null {
  const keys = Object.keys(item || {});
  return keys.find((k) => /^parentid1$/i.test(k) || /^leadid$/i.test(k)) ?? null;
}

// ID первого лида, созданного не раньше minDate — двоичным поиском по ID.
//
// ЗАЧЕМ. Начинать обход с нуля нельзя: Битрикс отдаёт по 50 записей за
// запрос, и вся история БФЛ до апреля прокручивалась бы вхолостую десятки
// минут, записывая ноль строк. Фильтр по системному DATE_CREATE тут не
// помощник — Битрикс его молча игнорирует (проверено на дневном импорте,
// см. комментарии в bitrix-import). А вот фильтр по ID работает честно,
// и ID монотонно растут вместе с датой создания — значит границу можно
// найти двоичным поиском примерно за 18 запросов вместо тысяч.
async function findStartLeadId(sourceIds: string[], minDate: string): Promise<number> {
  // Первый реально существующий лид с ID >= x (ID разрежены: между лидами
  // БФЛ лежат лиды других направлений, поэтому «взять лид с ID = mid»
  // не сработало бы).
  async function firstFrom(x: number): Promise<{ id: number; date: string } | null> {
    const json = await bitrixCall("crm.lead.list", {
      filter: { SOURCE_ID: sourceIds, ">=ID": x },
      select: ["ID", "DATE_CREATE"],
      order: { ID: "ASC" },
      start: 0,
    });
    const item = (json.result || [])[0];
    if (!item) return null;
    return { id: Number(item.ID), date: toDateMsk(item.DATE_CREATE) };
  }

  const maxJson = await bitrixCall("crm.lead.list", {
    filter: { SOURCE_ID: sourceIds },
    select: ["ID"],
    order: { ID: "DESC" },
    start: 0,
  });
  const maxId = Number((maxJson.result || [])[0]?.ID || 0);
  if (!maxId) return 0;

  let lo = 0;
  let hi = maxId;
  let answer = maxId;
  // Предохранитель: диапазон ниже честно делится пополам на каждом шаге, но
  // цена ошибки тут — бесконечный цикл запросов в Битрикс, поэтому ограничим
  // число шагов явно. 60 итераций хватает на диапазон в 10^18.
  for (let guard = 0; guard < 60 && lo <= hi; guard++) {
    const mid = Math.floor((lo + hi) / 2);
    const found = await firstFrom(mid);
    if (!found) {
      // Ни одного лида с ID >= mid — значит граница левее.
      hi = mid - 1;
      continue;
    }
    if (found.date >= minDate) {
      // Подходит: запоминаем и ищем границу левее.
      // ВАЖНО: двигаем hi именно по mid, а не по found.id. ID лидов БФЛ
      // разрежены, и found.id может оказаться сильно ПРАВЕЕ текущего hi —
      // тогда hi = found.id - 1 расширил бы диапазон вместо сужения, и
      // поиск зациклился бы.
      answer = found.id;
      hi = mid - 1;
    } else {
      // Слишком старый — граница правее найденного.
      lo = found.id + 1;
    }
  }
  // Курсор в обходе — строгий (">ID"), поэтому отступаем на единицу назад,
  // иначе первый же нужный лид будет пропущен.
  return Math.max(0, answer - 1);
}

async function readState(supabase: any): Promise<Record<string, string>> {
  const { data } = await supabase.from("bfl_timing_sync_state").select("key, value");
  const out: Record<string, string> = {};
  for (const row of data || []) out[row.key] = row.value;
  return out;
}

async function writeState(supabase: any, patch: Record<string, string>) {
  const rows = Object.entries(patch).map(([key, value]) => ({ key, value, updated_at: new Date().toISOString() }));
  if (rows.length) await supabase.from("bfl_timing_sync_state").upsert(rows, { onConflict: "key" });
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

    const [sourceMap, leadStatusMap, userMap] = await Promise.all([
      buildSourceMap(),
      buildLeadStatusMap(),
      buildUserMap().catch((e) => {
        // Права на user.get есть не у всякого вебхука. Без имён отчёт по
        // менеджерам будет пустым, но импорт из-за этого валить незачем.
        console.error("user.get failed:", String(e));
        return new Map<string, string>();
      }),
    ]);
    if (sourceMap.size === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: "В Битриксе не найдено ни одного источника с префиксом ofbfl-.",
      }), { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } });
    }
    const sourceIds = [...sourceMap.keys()];

    const state = await readState(supabase);
    let phase = body.reset ? "leads" : (state.phase || "leads");
    let leadsLastId = body.reset ? 0 : Number(state.leads_last_id || 0);
    let meetingsScan = body.reset ? 0 : Number(state.meetings_scan_start || 0);

    // Начало нового цикла: лиды догружаем инкрементально (дата создания и
    // дата квалификации задним числом не меняются... почти — квал могут
    // проставить позже, поэтому раз в цикл имеет смысл прогнать reset),
    // встречи пересканируем целиком.
    if (phase === "" || phase === "idle") {
      phase = "leads";
      meetingsScan = 0;
      await writeState(supabase, { phase, meetings_scan_start: "0" });
    }
    if (body.reset) {
      // Не с нуля, а сразу с границы нужного периода — иначе первые проходы
      // уходят на прокрутку старой истории впустую.
      leadsLastId = await findStartLeadId(sourceIds, LEAD_MIN_DATE);
      meetingsScan = 0;
      await writeState(supabase, {
        phase: "leads",
        leads_last_id: String(leadsLastId),
        meetings_scan_start: "0",
      });
    }

    let leadsUpserted = 0;
    let leadsScanned = 0;
    let meetingsUpserted = 0;
    let done = false;
    let leadField: string | null = state.meeting_lead_field || null;
    let meetingKeysSample: string[] = [];
    let meetingsWithoutLead = 0;

    // --- фаза 1: лиды ------------------------------------------------------
    while (phase === "leads" && timeLeft() > 8000) {
      const json = await bitrixCall("crm.lead.list", {
        filter: { SOURCE_ID: sourceIds, ">ID": leadsLastId },
        select: ["ID", "SOURCE_ID", "DATE_CREATE", "STATUS_ID", "ASSIGNED_BY_ID", FIELD_QUALIFIED_DATE],
        order: { ID: "ASC" },
        start: 0,
      });
      const page: any[] = json.result || [];
      if (page.length === 0) {
        phase = "meetings";
        meetingsScan = 0;
        await writeState(supabase, { phase, meetings_scan_start: "0" });
        break;
      }

      const rows: any[] = [];
      leadsScanned += page.length;
      for (const lead of page) {
        const createdIso = toIso(lead.DATE_CREATE);
        if (!createdIso) continue;
        if (toDateMsk(lead.DATE_CREATE) < LEAD_MIN_DATE) continue;
        rows.push({
          lead_id: Number(lead.ID),
          source_marker: sourceMap.get(String(lead.SOURCE_ID || "")) ?? null,
          created_at: createdIso,
          qualified_at: toIso(lead[FIELD_QUALIFIED_DATE]),
          status_id: lead.STATUS_ID ? String(lead.STATUS_ID) : null,
          status_name: leadStatusMap.get(String(lead.STATUS_ID || "")) ?? null,
          assigned_by_id: lead.ASSIGNED_BY_ID ? Number(lead.ASSIGNED_BY_ID) : null,
          assigned_by_name: userMap.get(String(lead.ASSIGNED_BY_ID || "")) ?? null,
          synced_at: new Date().toISOString(),
        });
      }
      if (rows.length) {
        await upsertChunked(supabase, "bfl_lead_timings", rows, "lead_id");
        leadsUpserted += rows.length;
      }

      leadsLastId = Math.max(...page.map((l: any) => Number(l.ID)));
      await writeState(supabase, { leads_last_id: String(leadsLastId) });
    }

    // --- фаза 2: встречи ---------------------------------------------------
    // select не указываем намеренно: нужны все поля, в том числе
    // ufCrm28Datetime и техническое поле статуса.
    //
    // Фильтра по стадии больше нет: раньше тянулась только «успех», то есть
    // были видны состоявшиеся встречи и не видно назначенных и отменённых —
    // доходимость посчитать было не из чего. Теперь берём всю воронку СП и
    // храним стадию, а что считать отменённой, разберём по факту.
    while (phase === "meetings" && timeLeft() > 8000) {
      const json = await bitrixCall("crm.item.list", {
        entityTypeId: MEETING_ENTITY_TYPE_ID,
        filter: { categoryId: MEETING_CATEGORY_ID },
        order: { id: "ASC" },
        start: meetingsScan,
      });
      const page: any[] = json.result?.items || [];
      if (page.length === 0) {
        phase = "idle";
        done = true;
        await writeState(supabase, { phase, meetings_scan_start: "0" });
        break;
      }

      if (meetingKeysSample.length === 0) meetingKeysSample = Object.keys(page[0]);
      if (!leadField) {
        leadField = detectLeadField(page[0]);
        if (leadField) await writeState(supabase, { meeting_lead_field: leadField });
      }

      const rows: any[] = [];
      for (const m of page) {
        // Момент встречи: настоящее время, и только если его нет — дата из
        // closedate. По нему же отсекаем период.
        const scheduledIso = toIso(m[FIELD_MEETING_DATETIME]);
        const heldIso = toIso(m.closedate);
        const momentIso = scheduledIso ?? heldIso;
        if (!momentIso) continue;
        if (toDateMsk(momentIso) < MEETING_MIN_DATE) continue;
        const rawLead = leadField ? m[leadField] : null;
        const leadId = rawLead ? Number(rawLead) : null;
        if (!leadId) meetingsWithoutLead += 1;
        rows.push({
          meeting_id: Number(m.id),
          lead_id: leadId && !isNaN(leadId) ? leadId : null,
          source_marker: sourceMap.get(String(m.sourceId || "")) ?? null,
          held_at: heldIso,
          scheduled_at: scheduledIso,
          created_time: toIso(m.createdTime),
          moved_time: toIso(m.movedTime),
          stage_id: String(m.stageId || ""),
          status_text: m[FIELD_MEETING_STATUS] ?? null,
          assigned_by_id: m.assignedById ? Number(m.assignedById) : null,
          assigned_by_name: userMap.get(String(m.assignedById || "")) ?? null,
          scheduled_by_name: userMap.get(String(m[FIELD_SCHEDULED_BY] || "")) ?? null,
          consulted_by_name: userMap.get(String(m[FIELD_CONSULTED_BY] || "")) ?? null,
          mko_department: MKO_DEPARTMENTS[String(m[FIELD_MKO_DEPARTMENT] || "")] ?? null,
          synced_at: new Date().toISOString(),
        });
      }
      if (rows.length) {
        await upsertChunked(supabase, "bfl_meeting_timings", rows, "meeting_id");
        meetingsUpserted += rows.length;
      }

      if (!json.next) {
        phase = "idle";
        done = true;
        await writeState(supabase, { phase, meetings_scan_start: "0" });
        break;
      }
      meetingsScan = json.next;
      await writeState(supabase, { meetings_scan_start: String(meetingsScan) });
    }

    return new Response(JSON.stringify({
      success: true,
      done,
      phase,
      leads_upserted: leadsUpserted,
      leads_scanned: leadsScanned,
      leads_last_id: leadsLastId,
      meetings_upserted: meetingsUpserted,
      meeting_lead_field: leadField,
      meetings_without_lead: meetingsWithoutLead,
      // Пригодится, только если связь найти не удалось: по списку полей
      // видно, чем на самом деле встреча связана с лидом.
      meeting_fields_sample: leadField ? [] : meetingKeysSample,
      elapsed_ms: Date.now() - startedAt,
    }), { headers: { ...corsHeaders, "Content-Type": "application/json" } });

  } catch (err) {
    console.error("bfl-timings error:", String(err));
    return new Response(JSON.stringify({ success: false, error: String(err) }), {
      status: 500,
      headers: { ...corsHeaders, "Content-Type": "application/json" },
    });
  }
});
