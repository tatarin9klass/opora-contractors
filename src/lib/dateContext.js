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
