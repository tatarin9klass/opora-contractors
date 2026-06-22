export const STATUS_BADGE = {
  'В переговорах':          'badge-negotiation',
  'Новый / подготовка':     'badge-new',
  'Тест':                   'badge-test',
  'Активен':                'badge-active',
  'Активен, под контролем': 'badge-control',
  'Снижен объём':           'badge-reduced',
  'Пауза':                  'badge-pause',
  'Неактивен':              'badge-inactive',
  'Отключён':               'badge-off',
  'Не брать':               'badge-notake',
  'Архив':                  'badge-archive',
}

export function getStatusClass(status) {
  return STATUS_BADGE[status] || 'badge-pause'
}

// CPL thresholds
export function cplClass(val) {
  if (!val) return 'metric-empty'
  if (val <= 1200) return 'metric-ok'
  if (val <= 1500) return 'metric-warn'
  return 'metric-danger'
}

export function cpqlClass(val) {
  if (!val) return 'metric-empty'
  if (val <= 6000) return 'metric-ok'
  if (val <= 7500) return 'metric-warn'
  return 'metric-danger'
}

export function cacClass(val) {
  if (!val) return 'metric-empty'
  if (val <= 50000) return 'metric-ok'
  if (val <= 75000) return 'metric-warn'
  return 'metric-danger'
}

export function metricCardClass(type, val) {
  if (!val) return 'neutral'
  if (type === 'cpl') return cplClass(val).replace('metric-', '')
  if (type === 'cpql') return cpqlClass(val).replace('metric-', '')
  if (type === 'cac') return cacClass(val).replace('metric-', '')
  return 'neutral'
}

export function formatMoney(val) {
  if (!val && val !== 0) return '—'
  return new Intl.NumberFormat('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 }).format(val)
}

export function formatNum(val) {
  if (!val && val !== 0) return '—'
  return new Intl.NumberFormat('ru-RU').format(val)
}

export function formatDate(str) {
  if (!str) return '—'
  return new Date(str).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

export function weekStart(date = new Date()) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  d.setDate(diff)
  return d.toISOString().split('T')[0]
}

export function currentMonth() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}
