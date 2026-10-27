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
  // Ключи метрик остались прежними: по ним уже заведены планы, и
  // переименование ради красоты обнулило бы их. Изменилось то, что считает
  // факт под планом «оксвсего» — теперь это заключённые договоры БФЛ.
  { id: 'оксвсего', label: 'Договоры БФЛ', unit: 'шт' },
  { id: 'оксаз', label: 'Договоры АЗ', unit: 'шт' },
  { id: 'оксвки', label: 'Договоры ВКИ', unit: 'шт' },
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

// ============================================================================
// Портфель: что у менеджера сейчас в работе.
//
// Поток отвечает на «как сработали», портфель — на «есть ли чем работать
// дальше». Это разные вопросы, и мерить их одной витриной нельзя: поток
// живёт событиями в периоде, портфель — снимком на сегодня.
// ============================================================================
export async function loadPortfolio() {
  const [portfolio, stuck, outside] = await Promise.all([
    fetchAllRows(() => supabase.from('rop_portal_portfolio').select('*')),
    fetchAllRows(() => supabase.from('rop_portal_stuck').select('*')
      .order('дней_без_движения', { ascending: false })),
    fetchAllRows(() => supabase.from('rop_portal_outside').select('*')),
  ])
  return { portfolio, stuck, outside }
}

// Этапы портфеля в порядке движения сделки. Порядок не алфавитный и не
// случайный: руководитель читает строку слева направо как путь, и если
// «договор» окажется раньше «ИКП», таблица начнёт врать глазу.
export const PORTFOLIO_STAGES = [
  { id: 'C34:NEW', label: 'Встреча' },
  { id: 'C34:PREPARATION', label: 'ИКП' },
  { id: 'C34:PREPAYMENT_INVOIC', label: 'Договор' },
  { id: 'C34:UC_1KT09S', label: 'Оплата' },
]

export function portfolioByManager(rows) {
  const m = new Map()
  for (const r of rows) {
    const key = r.менеджер
    if (!m.has(key)) {
      m.set(key, {
        менеджер: key, работает: r.работает !== false,
        всего: 0, залежалось: 0, приёмка: 0, ожидаемо: 0, без_суммы: 0,
        чек_сумма: 0, чек_сделок: 0, этапы: {},
      })
    }
    const c = m.get(key)
    const n = Number(r.сделок || 0)
    if (r.состояние === 'на приёмке') c.приёмка += n
    else c.всего += n
    c.залежалось += Number(r.залежалось || 0)
    c.ожидаемо += Number(r.ожидаемо_окс || 0)
    c.без_суммы += Number(r.без_суммы || 0)
    c.чек_сумма += Number(r.чек_сумма || 0)
    c.чек_сделок += Number(r.чек_сделок || 0)
    c.этапы[r.stage_id] = (c.этапы[r.stage_id] || 0) + n
  }
  return [...m.values()].sort((a, b) => (b.всего + b.приёмка) - (a.всего + a.приёмка))
}

// ============================================================================
// Экран «Сегодня»: список дел вместо списка цифр.
//
// ПОЧЕМУ СПИСОК ДЕЛ СОБИРАЕТСЯ ЗДЕСЬ, А НЕ В БАЗЕ. Правила, по которым
// сделка попадает в работу на сегодня, меняются чаще всего остального:
// сегодня «встреча без предложения третий день», завтра «второй». Держать
// их в витринах значило бы ходить в миграции за каждой такой правкой.
// Сделок три сотни, они приезжают целиком, и всё считается на месте.
// ============================================================================
export async function loadLost(fromISO, toISO) {
  return fetchAllRows(() => supabase.from('rop_portal_lost').select('*')
    .gte('дата', fromISO).lte('дата', toISO))
}

export async function loadDeals() {
  const [deals, pace] = await Promise.all([
    fetchAllRows(() => supabase.from('rop_portal_deals').select('*')),
    fetchAllRows(() => supabase.from('rop_portal_pace').select('*')),
  ])
  return { deals, pace }
}

// Деньги сделки: сперва товарные позиции, потом сумма в карточке. Если нет
// ни того, ни другого — ноль, и это видно отдельной строкой в списке дел.
export function dealMoney(d) {
  return Number(d.чек || 0) || Number(d.сумма_поля || 0) || 0
}

// Дела отдела на сегодня. Каждое — не метрика, а повод к разговору: есть
// заголовок, есть счёт, есть деньги и есть список карточек, который можно
// открыть и пройти по нему сверху вниз.
//
// ПОРЯДОК — ПО ДЕНЬГАМ, А НЕ ПО КОЛИЧЕСТВУ. Шесть зависших сделок на
// миллион важнее двадцати на сто тысяч, и сортировка обязана это понимать.
export function todoList(deals, { остатокПлана = null, ожидаемо = 0 } = {}) {
  const items = []
  const money = arr => arr.reduce((a, d) => a + dealMoney(d), 0)

  const залежались = deals.filter(d => d.залежалась && d.состояние === 'в работе')
  if (залежались.length) {
    items.push({
      id: 'stuck', tone: 'bad',
      title: 'Сделки стоят дольше нормы своего этапа',
      hint: 'норма у каждого этапа своя и взята из истории переходов',
      count: залежались.length, money: money(залежались), deals: залежались,
    })
  }

  // Встреча прошла, предложения нет. Правило жёсткое и намеренно не
  // выводится из истории: три дня — это управленческая норма, а не
  // наблюдение. Если ИКП не сформирован за три дня, разговор остыл.
  const безИкп = deals.filter(d => d.stage_id === 'C34:NEW' && d.дней_без_движения >= 3)
  if (безИкп.length) {
    items.push({
      id: 'no-ikp', tone: 'warn',
      title: 'Встреча прошла, предложение не сформировано',
      hint: 'третий день и дольше после консультации',
      count: безИкп.length, money: money(безИкп), deals: безИкп,
    })
  }

  const приёмка = deals.filter(d => d.состояние === 'на приёмке' && d.залежалась)
  if (приёмка.length) {
    items.push({
      id: 'accept', tone: 'warn',
      title: 'Зависли на приёмке в ОКС',
      hint: 'приёмка занимает до трёх рабочих дней',
      count: приёмка.length, money: money(приёмка), deals: приёмка,
    })
  }

  const уУшедших = deals.filter(d => d.работает === false)
  if (уУшедших.length) {
    items.push({
      id: 'left', tone: 'bad',
      title: 'Сделки на уволенном сотруднике',
      hint: 'их никто не ведёт — нужно передать',
      count: уУшедших.length, money: money(уУшедших), deals: уУшедших,
    })
  }

  const безДенег = deals.filter(d => d.stage_id === 'C34:PREPARATION'
    && !Number(d.чек) && !Number(d.сумма_поля))
  if (безДенег.length) {
    items.push({
      id: 'no-sum', tone: '',
      title: 'Предложение сформировано, а суммы нет',
      hint: 'ни товарных позиций, ни суммы в карточке — потенциал не посчитать',
      count: безДенег.length, money: 0, deals: безДенег,
    })
  }

  if (остатокПлана != null && остатокПлана > 0 && ожидаемо < остатокПлана) {
    items.push({
      id: 'gap', tone: 'bad', noDeals: true,
      title: 'Портфеля не хватает на остаток плана',
      hint: `при обычных шансах этапов выйдет ${Math.round(ожидаемо)} из ${остатокПлана} — нужны новые встречи`,
      count: остатокПлана - Math.round(ожидаемо), money: 0, deals: [],
    })
  }

  return items.sort((a, b) => (b.money - a.money) || (b.count - a.count))
}

// Нагрузка: у кого портфель заметно больше или меньше среднего по отделу.
// Решение о перераспределении принимает руководитель, но заметить перекос
// должен экран — иначе он так и останется двумя колонками в таблице.
export function loadBalance(deals) {
  const by = new Map()
  for (const d of deals) {
    if (d.состояние !== 'в работе') continue
    const c = by.get(d.менеджер) || { менеджер: d.менеджер, сделок: 0, залежалось: 0, деньги: 0 }
    c.сделок += 1
    if (d.залежалась) c.залежалось += 1
    c.деньги += dealMoney(d)
    by.set(d.менеджер, c)
  }
  const list = [...by.values()]
  if (list.length < 2) return { list, среднее: list[0]?.сделок || 0, перекос: null }
  const среднее = list.reduce((a, x) => a + x.сделок, 0) / list.length
  const max = list.reduce((a, b) => (a.сделок > b.сделок ? a : b))
  const min = list.reduce((a, b) => (a.сделок < b.сделок ? a : b))
  // Перекос считаем значимым от полутора раз: меньшая разница в отделе из
  // четырёх человек — обычная неравномерность недели, а не проблема.
  const перекос = min.сделок > 0 && max.сделок / min.сделок >= 1.5 ? { max, min } : null
  return { list: list.sort((a, b) => b.сделок - a.сделок), среднее, перекос }
}

// Предыдущий сопоставимый период. Для месяца — прошлый месяц целиком, для
// остальных — столько же дней подряд перед началом. Нужен затем, что
// «брак 29%» сам по себе не говорит ничего: он говорит только рядом с тем,
// сколько было.
export function prevBounds(mode, from, to) {
  if (mode === 'month') {
    const [y, m] = from.split('-').map(Number)
    const py = m === 1 ? y - 1 : y
    const pm = m === 1 ? 12 : m - 1
    return monthBounds(`${py}-${String(pm).padStart(2, '0')}-01`)
  }
  const days = Math.round(
    (new Date(to + 'T12:00:00Z') - new Date(from + 'T12:00:00Z')) / 86400000) + 1
  return { from: addDaysISO(from, -days), to: addDaysISO(from, -1) }
}

// Факт по дням и дневная норма. Ряд строится на весь период, а не только
// по дням с результатом: пустой день — это тоже факт, и если его выбросить,
// график покажет ровную работу там, где была неделя простоя.
//
// Будущие дни остаются null, а не нулём, — ноль означал бы «сделали ноль»,
// хотя день ещё не наступил.
export function dailySeries(rows, from, to, plan, pick = r => r.окс_бфл) {
  const byDay = new Map()
  for (const r of rows) {
    const d = String(r.дата).slice(0, 10)
    byDay.set(d, (byDay.get(d) || 0) + Number(pick(r) || 0))
  }
  const total = Math.round(
    (new Date(to + 'T12:00:00Z') - new Date(from + 'T12:00:00Z')) / 86400000) + 1
  const today = todayISO()
  const out = []
  for (let i = 0; i < total; i++) {
    const d = addDaysISO(from, i)
    out.push({ дата: d, факт: d <= today ? (byDay.get(d) || 0) : null })
  }
  return { дни: out, норма: plan == null ? null : plan / total }
}

// Квота: сколько договоров надо заключать каждый оставшийся день, чтобы
// выйти на план. (план − факт) ÷ оставшиеся календарные дни, сегодняшний
// день считается оставшимся — он ещё не кончился.
//
// Отличие от дневной нормы на графике в том, что норма не меняется весь
// месяц, а квота растёт с каждым отставанием. Поэтому она и стоит плиткой
// рядом с фактом, а не линией на графике.
export function quotaPerDay(plan, fact, toISO, today = todayISO()) {
  if (plan == null) return null
  const осталосьДней = Math.round(
    (new Date(toISO + 'T12:00:00Z') - new Date(today + 'T12:00:00Z')) / 86400000) + 1
  if (осталосьДней <= 0) return { дней: 0, осталось: Math.max(0, plan - fact), квота: null }
  const осталось = Math.max(0, plan - fact)
  return { дней: осталосьДней, осталось, квота: Math.round((осталось / осталосьДней) * 10) / 10 }
}
