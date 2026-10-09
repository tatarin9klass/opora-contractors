import { supabase, fetchAllRows } from './supabase.js'
import { addDaysISO, todayISO, weekStartOf } from './dateContext.js'

// ============================================================================
// Кабинет подрядчика: загрузка и выгрузка.
//
// ВСЕ ЗАПРОСЫ ИДУТ ТОЛЬКО К ВЬЮХАМ portal_*. Это не соглашение об аккуратности,
// а единственное, что подрядчику вообще доступно: политик на базовых таблицах
// у его роли нет ни одной, и запрос к daily_facts или sources вернёт ему ноль
// строк. Поэтому ошибиться тут безопасно — максимум получится пустой экран, а
// не чужие данные.
//
// ДВЕ ЛОГИКИ ДАТ, КОТОРЫЕ НЕЛЬЗЯ ПУТАТЬ:
//   loadDaily  — наша отчётная логика: квал в день квалификации, встреча в
//                день встречи, договор в день оплаты.
//   loadLeads  — по дате СОЗДАНИЯ заявки, стадия фактическая на сейчас.
// Эти два набора не сходятся по определению, и экран обязан об этом сказать.
// ============================================================================

// Московская граница суток. Дата создания лида хранится как timestamptz, и
// если фильтровать по 'YYYY-MM-DD' без зоны, PostgREST поймёт её как UTC —
// заявки с 00:00 до 03:00 по Москве уедут в предыдущий день.
const DAY_START = 'T00:00:00+03:00'

export async function loadProfile() {
  const { data, error } = await supabase.from('portal_my_profile').select('*').maybeSingle()
  if (error) throw error
  return data
}

export async function loadStageGuide() {
  const { data, error } = await supabase
    .from('portal_stage_guide')
    .select('*')
    .order('sort_order')
  if (error) throw error
  return data || []
}

// Дашборд: по нашей отчётной логике.
export async function loadDaily(fromISO, toISO) {
  return fetchAllRows(() =>
    supabase
      .from('portal_my_daily')
      .select('*')
      .gte('fact_date', fromISO)
      .lte('fact_date', toISO)
      .order('fact_date'),
  )
}

// Выгрузка: по дате создания заявки.
export async function loadLeads(fromISO, toISO) {
  return fetchAllRows(() =>
    supabase
      .from('portal_my_leads')
      .select('*')
      .gte('created_at', fromISO + DAY_START)
      .lt('created_at', addDaysISO(toISO, 1) + DAY_START)
      .order('created_at', { ascending: false }),
  )
}

// --- Период ------------------------------------------------------------------
// День, отчётная неделя (чт-ср, как во всём приложении) и произвольный период.
// Неделя именно четверг-среда, а не календарная: подрядчик и мы должны
// обсуждать одну и ту же неделю, иначе любой разговор о динамике разъезжается.
export function periodBounds(mode, anchorISO, fromISO, toISO) {
  if (mode === 'day') return { from: anchorISO, to: anchorISO }
  if (mode === 'week') {
    const thu = weekStartOf(anchorISO)
    return { from: thu, to: addDaysISO(thu, 6) }
  }
  const a = fromISO || anchorISO
  const b = toISO || anchorISO
  return a <= b ? { from: a, to: b } : { from: b, to: a }
}

// Последние N отчётных недель, от текущей назад — для выпадающего списка.
export function recentWeeks(count = 12, today = todayISO()) {
  const out = []
  let thu = weekStartOf(today)
  for (let i = 0; i < count; i++) {
    out.push({ start: thu, end: addDaysISO(thu, 6) })
    thu = addDaysISO(thu, -7)
  }
  return out
}

// --- Выгрузка в файл ---------------------------------------------------------
// CSV с BOM и точкой с запятой: Excel в русской локали открывает такой файл
// двойным щелчком и не ломает кириллицу. Без BOM он показывает кракозябры, с
// запятой вместо точки с запятой — складывает всю строку в одну колонку.
function csvCell(v) {
  if (v == null) return ''
  const s = String(v)
  return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(headers, rows) {
  const lines = [headers.map(csvCell).join(';')]
  for (const r of rows) lines.push(r.map(csvCell).join(';'))
  return '﻿' + lines.join('\r\n')
}

export function downloadCsv(filename, text) {
  const blob = new Blob([text], { type: 'text/csv;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

// Дата и время создания — в московской зоне и в человеческом виде. Подрядчик
// сверяет выгрузку со своей системой, и ISO с суффиксом Z он прочитает как
// время на три часа раньше настоящего.
export function formatMoscow(iso) {
  if (!iso) return ''
  const d = new Date(iso)
  if (isNaN(d.getTime())) return ''
  const parts = new Intl.DateTimeFormat('ru-RU', {
    timeZone: 'Europe/Moscow',
    day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit',
  }).formatToParts(d)
  const m = {}
  for (const p of parts) m[p.type] = p.value
  return `${m.day}.${m.month}.${m.year} ${m.hour}:${m.minute}`
}

export const LEAD_EXPORT_HEADERS = [
  'Телефон',
  'Дата и время создания',
  'Стадия в воронке',
  'Квал',
  'UTM',
  'utm_source',
  'utm_medium',
  'utm_campaign',
  'utm_content',
  'utm_term',
  'Источник',
]

export function leadExportRow(l) {
  return [
    l.phone || '',
    formatMoscow(l.created_at),
    l.stage || '',
    l.is_qual ? 'да' : '',
    l.utm || '',
    l.utm_source || '',
    l.utm_medium || '',
    l.utm_campaign || '',
    l.utm_content || '',
    l.utm_term || '',
    l.source_marker || '',
  ]
}
