// Полная сумма договоров и месячные денежные планы. Не зависит от API.
export const MONEY_METRIC = 'договоры_сумма'

const roundMoney = value => Math.round((value + Number.EPSILON) * 100) / 100
const dayNumber = iso => Date.parse(`${iso}T00:00:00Z`) / 86400000

export function contractAmountTotal(rows, manager = null) {
  let cents = 0, missing = 0, contracts = 0
  for (const row of rows) {
    if (manager != null && row.менеджер !== manager) continue
    cents += Math.round(Number(row.сумма_договоров || 0) * 100)
    missing += Number(row.договоров_без_суммы || 0)
    contracts += Number(row.договоров || 0)
  }
  return { amount: cents / 100, missing, contracts }
}

// Сначала округляем план каждого менеджера до копеек, затем складываем:
// итог отдела всегда совпадает с суммой показанных планов людей.
export function moneyPlanFor(plans, from, to, manager = null, team = null) {
  const byManager = new Map()
  for (const row of plans) {
    if (row.metric !== MONEY_METRIC || !row.manager_name) continue
    if (team && row.отдел !== team) continue
    if (manager != null && row.manager_name !== manager) continue
    const month = String(row.period).slice(0, 10)
    const [year, m] = month.split('-').map(Number)
    const days = new Date(Date.UTC(year, m, 0)).getUTCDate()
    const end = `${month.slice(0, 8)}${String(days).padStart(2, '0')}`
    const overlap = Math.max(0, dayNumber(to < end ? to : end) - dayNumber(from > month ? from : month) + 1)
    if (!overlap) continue
    byManager.set(row.manager_name,
      (byManager.get(row.manager_name) || 0) + Number(row.value) * overlap / days)
  }
  if (!byManager.size) return null
  return roundMoney([...byManager.values()].reduce((sum, value) => sum + roundMoney(value), 0))
}

export function parsePlanValue(raw) {
  const value = String(raw ?? '').replace(/\s/g, '').replace(',', '.')
  if (!value) return null
  if (!/^\d+(\.\d{1,2})?$/.test(value) || !Number.isFinite(Number(value))) {
    throw new Error('Введите неотрицательное число, не более двух знаков после запятой.')
  }
  return Number(value)
}

export function formatContractMoney(value) {
  return value == null ? '—' : new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value) + ' ₽'
}
