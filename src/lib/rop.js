import { supabase, fetchAllRows } from './supabase.js'
import { todayISO, addDaysISO, weekStartOf } from './dateContext.js'

// ============================================================================
// Кабинет руководителя отдела продаж: данные и расчёты.
//
// ВСЁ СЧИТАЕТСЯ ПО ДАТЕ СОБЫТИЯ. Встреча относится к дню, когда сделка попала
// на «Встреча проведена», передача в ОКС — ко дню перехода в
// делопроизводство. Та же логика, по которой живёт управленческий учёт
// направления, и это не случайность: руководитель и директор должны
// обсуждать одни и те же числа.
//
// ПЕРЕДАЧА В ОКС НЕ СВЯЗАНА СО ВСТРЕЧЕЙ НАПРЯМУЮ. В Битриксе передача
// оформляется НОВОЙ карточкой, у которой нет истории встречи. Поэтому
// передачи месяца относятся к встречам, которые были раньше, и делить одно
// на другое нельзя: получалось бы больше ста процентов, что мы и увидели на
// рекомендациях (34 передачи при 32 встречах). Конверсии считаются только
// там, где этапы проходит одна и та же сделка: встреча → ИКП → договор →
// оплата.
// ============================================================================

export const GROUPS = [
  { id: 'маркетинг', label: 'Маркетинг' },
  { id: 'рекомендации', label: 'Рекомендации' },
  { id: 'прочее', label: 'Прочее' },
]

// Метрики, у которых есть план. Брак — единственная с обратным знаком:
// у неё зелёная зона снизу, и путать её с остальными нельзя.
export const PLAN_METRICS = [
  { id: 'оксвсего', label: 'Передано в ОКС', unit: 'шт' },
  { id: 'оксаз', label: 'Передано в ОКС — АЗ', unit: 'шт' },
  { id: 'оксвки', label: 'Передано в ОКС — ВКИ', unit: 'шт' },
  { id: 'встречи', label: 'Встречи', unit: 'шт' },
  { id: 'среднийчек', label: 'Средний чек', unit: '₽' },
  { id: 'бракнорма', label: 'Брак, норма не выше', unit: '%', inverse: true },
]

export async function loadRopData(fromISO, toISO) {
  const [daily, byManager, plans, stageSince, managers, teams] = await Promise.all([
    fetchAllRows(() => supabase.from('rop_portal_daily').select('*')
      .gte('дата', fromISO).lte('дата', toISO)),
    fetchAllRows(() => supabase.from('rop_portal_manager').select('*')
      .gte('дата', fromISO).lte('дата', toISO)),
    fetchAllRows(() => supabase.from('rop_portal_plans').select('*')),
    fetchAllRows(() => supabase.from('rop_portal_stage_since').select('*')),
    fetchAllRows(() => supabase.from('rop_portal_managers').select('*')),
    fetchAllRows(() => supabase.from('rop_portal_teams').select('*').order('sort_order')),
  ])
  return { daily, byManager, plans, stageSince, managers, teams }
}

// Отбор по отделу. База и так отдаёт руководителю только его строки, но
// сотруднику видны оба отдела, и смешивать их в одной цифре нельзя: это
// разные люди с разными планами. Пустой team означает «всё, что пришло».
export function byTeam(rows, team) {
  if (!team) return rows
  return rows.filter(r => r.отдел === team)
}

// --- Период ------------------------------------------------------------------
export function monthBounds(anchorISO) {
  const first = anchorISO.slice(0, 8) + '01'
  const [y, m] = first.split('-').map(Number)
  const days = new Date(Date.UTC(y, m, 0)).getUTCDate()
  return { from: first, to: `${first.slice(0, 8)}${String(days).padStart(2, '0')}`, days }
}

export function periodBounds(mode, anchorISO, fromISO, toISO, today = todayISO()) {
  if (mode === 'month') {
    const b = monthBounds(anchorISO || today)
    return { from: b.from, to: b.to }
  }
  if (mode === 'week') {
    const thu = weekStartOf(anchorISO || today)
    return { from: thu, to: addDaysISO(thu, 6) }
  }
  const a = fromISO || today
  const b = toISO || today
  return a <= b ? { from: a, to: b } : { from: b, to: a }
}

export function recentMonths(count = 12, today = todayISO()) {
  const NAMES = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
    'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
  const out = []
  let [y, m] = today.split('-').map(Number)
  for (let i = 0; i < count; i++) {
    const first = `${y}-${String(m).padStart(2, '0')}-01`
    // Сделки импортируются с 1 сентября 2026 — предлагать более ранние
    // месяцы значит обещать пустой экран.
    if (first < '2026-09-01') break
    out.push({ start: first, label: `${NAMES[m - 1]} ${y}` })
    m -= 1
    if (m === 0) { m = 12; y -= 1 }
  }
  return out
}

// --- Свод --------------------------------------------------------------------
const ZERO = {
  встречи: 0, брак: 0, икп: 0, договор_без_оплаты: 0, оплата: 0,
  окс_всего: 0, окс_аз: 0, окс_вки: 0, окс_бфл: 0,
  чек_сумма: 0, чек_сделок: 0, фпа_сумма: 0,
}

export function sumRows(rows, groupFilter = null) {
  const t = { ...ZERO }
  for (const r of rows) {
    if (groupFilter && r.группа !== groupFilter) continue
    for (const k of Object.keys(ZERO)) t[k] += Number(r[k] || 0)
  }
  return t
}

// Средний чек считается из суммы и количества, а не усреднением дневных
// средних: среднее нельзя усреднять, иначе месяц из тридцати дней даст
// цифру тем дальше от правды, чем неравномернее дни.
export function avgCheck(t) {
  return t.чек_сделок ? Math.round(t.чек_сумма / t.чек_сделок) : null
}

export function brakShare(t) {
  const base = t.встречи
  return base ? (100 * t.брак) / base : null
}

// --- План/факт ---------------------------------------------------------------
export function planFor(plans, periodISO, metric, managerName = null, team = null) {
  const month = periodISO.slice(0, 8) + '01'
  const row = plans.find(p =>
    String(p.period).slice(0, 10) === month &&
    p.metric === metric &&
    (team ? p.отдел === team : true) &&
    (managerName ? p.manager_name === managerName : !p.manager_name))
  return row ? Number(row.value) : null
}

// Темп: сколько выйдет к концу месяца, если дальше пойдёт как сейчас.
// Считается только для текущего месяца — для прошедшего это и есть факт.
export function runRate(fact, fromISO, toISO, today = todayISO()) {
  if (today < fromISO) return null
  if (today > toISO) return fact
  const total = daysBetween(fromISO, toISO) + 1
  const passed = daysBetween(fromISO, today) + 1
  if (passed <= 0 || passed >= total) return fact
  return Math.round((fact / passed) * total)
}

function daysBetween(a, b) {
  return Math.round((new Date(b + 'T12:00:00Z') - new Date(a + 'T12:00:00Z')) / 86400000)
}

// Какая часть периода уже прошла. 0 — ещё не начался, 1 — закрыт.
export function periodShare(fromISO, toISO, today = todayISO()) {
  if (today > toISO) return 1
  if (today < fromISO) return 0
  const total = daysBetween(fromISO, toISO) + 1
  const passed = daysBetween(fromISO, today) + 1
  return Math.min(1, Math.max(0, passed / total))
}

// Сколько должно быть сделано К ЭТОМУ ДНЮ, а не к концу месяца.
//
// БЕЗ ЭТОГО ВЕСЬ МЕСЯЦ ГОРИТ КРАСНЫМ. Девятнадцатого октября двадцать одна
// передача против плана в сорок — это ровно по графику, но при сравнении с
// месячным планом экран скажет «53%, провал». Руководитель, у которого
// панель краснеет три недели из четырёх, перестаёт на неё смотреть, и тогда
// она не показывает ничего.
//
// Доля прошедших дней применяется только к объёмам. Средний чек и норма
// брака — не объёмы: к концу месяца они не растут, и делить их на дни
// значило бы печатать бессмыслицу.
export function paceTarget(plan, fromISO, toISO, additive = true, today = todayISO()) {
  if (plan == null) return null
  if (!additive) return plan
  return plan * periodShare(fromISO, toISO, today)
}

// Цвет оценки. У брака шкала перевёрнута: меньше — лучше.
export function planStatus(fact, plan, inverse = false) {
  if (plan == null || fact == null) return ''
  const ratio = plan === 0 ? null : fact / plan
  if (ratio == null) return ''
  if (inverse) {
    if (ratio <= 1) return 'ok'
    return ratio <= 1.15 ? 'warn' : 'bad'
  }
  if (ratio >= 1) return 'ok'
  return ratio >= 0.85 ? 'warn' : 'bad'
}

// --- Этапы, которых не было ---------------------------------------------------
// Часть этапов воронки заведена недавно: «Полная/частичная оплата» живёт с
// 3 октября. За более ранний период по ним не ноль, а отсутствие
// показателя — руководитель прочитает ноль как провал отдела.
export const STAGE_OF_METRIC = {
  оплата: 'C34:UC_1KT09S',
  договор_без_оплаты: 'C34:PREPAYMENT_INVOIC',
  икп: 'C34:PREPARATION',
  окс_всего: 'C34:WON',
  встречи: 'C34:NEW',
  брак: 'C34:7',
}

export function stageMissing(stageSince, metricKey, fromISO) {
  const id = STAGE_OF_METRIC[metricKey]
  if (!id) return null
  const row = stageSince.find(s => s.stage_id === id)
  if (!row || !row.этап_с) return null
  return String(row.этап_с) > fromISO ? String(row.этап_с) : null
}

export function formatMoneyShort(v) {
  if (v == null) return '—'
  return new Intl.NumberFormat('ru-RU').format(Math.round(v)) + ' ₽'
}
