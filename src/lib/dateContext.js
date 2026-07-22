// Единая точка расчёта "сегодня" и границ отчётной недели (чт-ср), явно в
// таймзоне Europe/Moscow. Раньше здесь использовался toISOString() поверх
// Date-объекта с локальной полночью — toISOString() всегда переводит в UTC,
// поэтому для любого часового пояса восточнее UTC (вся Россия) дата
// систематически съезжала на день назад. См. docs/TZ.md, раздел 2.

const TIME_ZONE = 'Europe/Moscow'

const WEEKDAY_INDEX = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }

function moscowYmd(date) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date)
  const map = {}
  for (const p of parts) map[p.type] = p.value
  return `${map.year}-${map.month}-${map.day}`
}

// "Сегодня" в Москве, как строка YYYY-MM-DD.
export function todayISO(referenceDate = new Date()) {
  return moscowYmd(referenceDate)
}

// UTC-полдень как якорь: гарантированно тот же календарный день в любой
// разумной таймзоне, включая Москву (UTC+3) — исключает эффекты смены дня
// при арифметике над датами.
function anchor(isoDateStr) {
  return new Date(`${isoDateStr}T12:00:00Z`)
}

function dayOfWeek(isoDateStr) {
  const weekday = new Intl.DateTimeFormat('en-US', { timeZone: TIME_ZONE, weekday: 'short' }).format(anchor(isoDateStr))
  return WEEKDAY_INDEX[weekday]
}

export function addDaysISO(isoDateStr, n) {
  const d = anchor(isoDateStr)
  d.setUTCDate(d.getUTCDate() + n)
  return moscowYmd(d)
}

// Возвращает дату четверга отчётной недели (чт-ср), которой принадлежит isoDateStr.
export function weekStartOf(isoDateStr) {
  const dow = dayOfWeek(isoDateStr) // 0=вс..6=сб
  const diff = dow >= 4 ? dow - 4 : dow + 3
  return addDaysISO(isoDateStr, -diff)
}

// Четверг отчётной недели, которой принадлежит "сегодня" (по умолчанию — текущий момент).
export function weekStart(referenceDate = new Date()) {
  return weekStartOf(todayISO(referenceDate))
}

// Полный контекст для ImportPage: сегодня, текущая неделя, доступность
// прошлой недели (только по четвергам, до заморозки).
export function computeDateContext(referenceDate = new Date()) {
  const todayStr = todayISO(referenceDate)
  const currentWeekThu = weekStartOf(todayStr)
  const isThursday = todayStr === currentWeekThu

  const currentWeekDays = []
  for (let i = 0; i < 7; i++) {
    const d = addDaysISO(currentWeekThu, i)
    if (d > todayStr) break
    currentWeekDays.push(d)
  }

  let previousWeekDays = []
  if (isThursday) {
    const prevWeekThu = addDaysISO(currentWeekThu, -7)
    for (let i = 0; i < 7; i++) previousWeekDays.push(addDaysISO(prevWeekThu, i))
  }

  return {
    todayISO: todayStr,
    currentWeekThuISO: currentWeekThu,
    isThursday,
    currentWeekDays,
    previousWeekDays,
  }
}

// Сколько календарных дней прошло от fromISO до toISO (может быть отрицательным).
export function daysBetweenISO(fromISO, toISO) {
  return Math.round((anchor(toISO) - anchor(fromISO)) / 86400000)
}

// Доля периода (недели чт-ср или месяца), которая уже прошла на referenceDate —
// используется, чтобы план дашборда сравнивался с фактом "по темпу", а не с
// планом на весь период целиком (иначе 1 числа месяца план всегда красный).
// periodStart — четверг недели (для mode='week') или первое число месяца
// (для mode='month'), в формате YYYY-MM-DD.
// Для уже полностью прошедшего периода возвращает 1 (план целиком) — темп
// имеет смысл только для ТЕКУЩЕГО, ещё идущего периода.
export function periodPaceRatio(mode, periodStart, referenceDate = new Date()) {
  const todayStr = todayISO(referenceDate)
  if (mode === 'week') {
    const weekEnd = addDaysISO(periodStart, 6)
    if (todayStr < periodStart) return 0
    if (todayStr > weekEnd) return 1
    const elapsed = daysBetweenISO(periodStart, todayStr) + 1
    return Math.min(elapsed, 7) / 7
  }
  const [y, m] = periodStart.split('-').map(Number)
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate()
  const monthEnd = `${periodStart.slice(0, 8)}${String(daysInMonth).padStart(2, '0')}`
  if (todayStr < periodStart) return 0
  if (todayStr > monthEnd) return 1
  const dayOfMonth = daysBetweenISO(periodStart, todayStr) + 1
  return Math.min(dayOfMonth, daysInMonth) / daysInMonth
}
