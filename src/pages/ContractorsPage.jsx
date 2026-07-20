import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { getStatusClass, cplClass, cpqlClass, formatMoney, formatDate } from '../lib/helpers.js'
import { weekStart as getWeekStart } from '../lib/dateContext.js'
import AddContractorModal from '../components/AddContractorModal.jsx'

const STATUS_FILTERS = [
  { label: 'Все', value: 'all' },
  { label: 'Активные', value: 'active' },
  { label: 'Тест', value: 'test' },
  { label: 'Пауза', value: 'pause' },
  { label: 'Неактивные', value: 'inactive' },
  { label: '⛔ Не брать', value: 'notake' },
]

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7)
}

function weekLabel(dateStr) {
  const d = new Date(dateStr)
  const isCurrent = dateStr === getWeekStart()
  return `${getISOWeek(d)} неделя ${d.getFullYear()}${isCurrent ? ' (текущая)' : ''}`
}

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`
}

function monthLabel(dateStr) {
  return new Date(dateStr).toLocaleString('ru-RU', { month: 'long', year: 'numeric' })
}

function nextMonth(m) {
  const d = new Date(m)
  d.setMonth(d.getMonth() + 1)
  return monthKey(d)
}

// ТЗ раздел 6.2/7: отклонение >20% от личного плана подрядчика за выбранный
// период — направление зависит от метрики (расход — если выше плана,
// остальное — если ниже). В режиме "неделя" план приводится к неделе тем же
// коэффициентом, что и на дашборде.
const DEVIATION_COST_METRICS = new Set(['spend'])
const DEVIATION_THRESHOLD = 0.2
const WEEK_RATIO = 1 / 4.33

function hasDeviationAlert(fact, target, mode) {
  if (!target) return false
  const pairs = [
    ['spend', fact.spend, target.plan_spend],
    ['leads', fact.leads, target.plan_leads],
    ['quals', fact.quals, target.plan_quals],
    ['meetings', fact.meetings, target.plan_meetings],
    ['deals', fact.deals, target.plan_deals],
  ]
  return pairs.some(([key, factVal, planRaw]) => {
    if (planRaw == null) return false
    const planPeriod = mode === 'week' ? planRaw * WEEK_RATIO : planRaw
    if (!planPeriod) return false
    const dev = ((factVal || 0) - planPeriod) / planPeriod
    return DEVIATION_COST_METRICS.has(key) ? dev > DEVIATION_THRESHOLD : dev < -DEVIATION_THRESHOLD
  })
}

export default function ContractorsPage({ onOpenPassport }) {
  const [mode, setMode] = useState('week')
  const [selectedWeek, setSelectedWeek] = useState(getWeekStart())
  const [selectedMonth, setSelectedMonth] = useState(monthKey())
  const [rows, setRows] = useState([])
  const [targets, setTargets] = useState({})
  const [weeklyStats, setWeeklyStats] = useState([])
  const [availableWeeks, setAvailableWeeks] = useState([])
  const [availableMonths, setAvailableMonths] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('')
  const [types, setTypes] = useState([])
  const [showAdd, setShowAdd] = useState(false)
  const [sortKey, setSortKey] = useState(null)
  const [sortDir, setSortDir] = useState('desc') // 'asc' | 'desc'

  async function load() {
    setLoading(true)
    const [{ data }, { data: targetRows }, { data: statsRows }] = await Promise.all([
      supabase.from('contractor_mtd').select('*'),
      supabase.from('contractor_targets').select('*'),
      supabase.from('weekly_stats').select('*'),
    ])
    setRows(data || [])
    const targetsMap = {}
    ;(targetRows || []).forEach(t => { targetsMap[t.contractor_id] = t })
    setTargets(targetsMap)

    const stats = statsRows || []
    setWeeklyStats(stats)
    const weeks = [...new Set(stats.map(w => w.week_start))].sort((a, b) => b.localeCompare(a))
    setAvailableWeeks(weeks)
    const now = new Date()
    const futureMonths = [0, 1, 2].map(offset => monthKey(new Date(now.getFullYear(), now.getMonth() + offset, 1)))
    const months = [...new Set([...futureMonths, ...weeks.map(w => monthKey(new Date(w)))])].sort((a, b) => b.localeCompare(a))
    setAvailableMonths(months)

    setLoading(false)
  }

  useEffect(() => {
    load()
    supabase.from('contractor_types').select('*').order('name').then(({ data }) => setTypes(data || []))
  }, [])

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'name' ? 'asc' : 'desc') // числовые по убыванию по умолчанию, имя по алфавиту
    }
  }

  // Факт за выбранный период (неделя/месяц) по каждому подрядчику — из
  // weekly_stats, тот же источник правды, что и на дашборде.
  const periodRows = mode === 'month'
    ? weeklyStats.filter(r => r.week_start >= selectedMonth && r.week_start < nextMonth(selectedMonth))
    : weeklyStats.filter(r => r.week_start === selectedWeek)

  const periodByContractor = {}
  periodRows.forEach(r => {
    if (!r.contractor_id) return
    if (!periodByContractor[r.contractor_id]) periodByContractor[r.contractor_id] = { leads: 0, quals: 0, meetings: 0, deals: 0, spend: 0 }
    const a = periodByContractor[r.contractor_id]
    a.leads += r.leads || 0
    a.quals += r.quals || 0
    a.meetings += r.meetings || 0
    a.deals += r.deals || 0
    a.spend += Number(r.spend) || 0
  })

  function periodFact(contractorId) {
    const a = periodByContractor[contractorId] || { leads: 0, quals: 0, meetings: 0, deals: 0, spend: 0 }
    return {
      ...a,
      cpl: a.leads > 0 ? Math.round(a.spend / a.leads) : null,
      cpql: a.quals > 0 ? Math.round(a.spend / a.quals) : null,
    }
  }

  const periodLabel = mode === 'month' ? monthLabel(selectedMonth) : weekLabel(selectedWeek)

  const SORTABLE_COLUMNS = [
    { key: 'name', label: 'Подрядчик', field: r => (r.short_name || r.name || '').toLowerCase() },
    { key: 'leads', label: 'Лиды', field: r => periodFact(r.contractor_id).leads },
    { key: 'spend', label: 'Расход', field: r => periodFact(r.contractor_id).spend },
    { key: 'cpl', label: 'CPL', field: r => periodFact(r.contractor_id).cpl ?? -1 },
    { key: 'quals', label: 'Квалы', field: r => periodFact(r.contractor_id).quals },
    { key: 'cpql', label: 'CPQL', field: r => periodFact(r.contractor_id).cpql ?? -1 },
    { key: 'meetings', label: 'Встречи', field: r => periodFact(r.contractor_id).meetings },
    { key: 'deals', label: 'Сделки', field: r => periodFact(r.contractor_id).deals },
    { key: 'updated', label: 'Обновлён', field: r => r.updated_at || '' },
  ]

  const filtered = rows.filter(r => {
    if (search && !r.name?.toLowerCase().includes(search.toLowerCase()) && !r.short_name?.toLowerCase().includes(search.toLowerCase())) return false
    if (typeFilter && r.type !== typeFilter) return false
    if (statusFilter === 'active') return r.is_active && r.status !== 'Тест'
    if (statusFilter === 'test') return r.status === 'Тест'
    if (statusFilter === 'pause') return r.status === 'Пауза'
    if (statusFilter === 'inactive') return !r.is_active && r.status !== 'Не брать' && r.status !== 'Пауза'
    if (statusFilter === 'notake') return r.status === 'Не брать'
    return true
  })

  const sortedRows = [...filtered]
  if (sortKey) {
    const col = SORTABLE_COLUMNS.find(c => c.key === sortKey)
    if (col) {
      sortedRows.sort((a, b) => {
        const av = col.field(a)
        const bv = col.field(b)
        if (typeof av === 'string') {
          const cmp = av.localeCompare(bv)
          return sortDir === 'asc' ? cmp : -cmp
        }
        const cmp = av - bv
        return sortDir === 'asc' ? cmp : -cmp
      })
    }
  }

  const activeCount = rows.filter(r => r.is_active).length
  const testCount = rows.filter(r => r.status === 'Тест').length
  const alertCount = rows.filter(r => r.is_active && hasDeviationAlert(periodFact(r.contractor_id), targets[r.contractor_id], mode)).length

  function SortIcon({ colKey }) {
    if (sortKey !== colKey) return <span style={{ opacity: 0.25, marginLeft: 4 }}>↕</span>
    return <span style={{ marginLeft: 4, color: 'var(--green-primary)' }}>{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
            Период
          </div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{periodLabel}</div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ display: 'flex', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 24, padding: 3 }}>
            {['month', 'week'].map(m => (
              <button key={m} onClick={() => setMode(m)} style={{
                padding: '6px 16px', borderRadius: 20, border: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer',
                background: mode === m ? 'var(--green-dark)' : 'transparent',
                color: mode === m ? '#fff' : 'var(--text-secondary)',
                transition: 'all 0.15s'
              }}>{m === 'month' ? 'Месяц' : 'Неделя'}</button>
            ))}
          </div>
          {mode === 'month' ? (
            <select className="form-select" style={{ minWidth: 200 }} value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}>
              {availableMonths.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
            </select>
          ) : (
            <select className="form-select" style={{ minWidth: 200 }} value={selectedWeek} onChange={e => setSelectedWeek(e.target.value)}>
              {availableWeeks.length === 0
                ? <option value={getWeekStart()}>{weekLabel(getWeekStart())}</option>
                : availableWeeks.map(w => <option key={w} value={w}>{weekLabel(w)}</option>)
              }
            </select>
          )}
        </div>
      </div>

      <div className="kpi-row">
        <div className="kpi-card green">
          <div className="kpi-label">Активных</div>
          <div className="kpi-value">{activeCount}</div>
          <div className="kpi-sub">из {rows.length} всего</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">На тесте</div>
          <div className="kpi-value">{testCount}</div>
        </div>
        <div className="kpi-card yellow">
          <div className="kpi-label">Зоны внимания</div>
          <div className="kpi-value">{alertCount}</div>
          <div className="kpi-sub">отклонение &gt;20% от плана за период</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Всего подрядчиков</div>
          <div className="kpi-value">{rows.length}</div>
        </div>
      </div>

      <div className="filters-bar">
        {STATUS_FILTERS.map(f => (
          <button key={f.value} className={`filter-chip ${statusFilter === f.value ? 'active' : ''}`} onClick={() => setStatusFilter(f.value)}>
            {f.label}
          </button>
        ))}
      </div>

      <div className="table-wrap">
        <div className="table-toolbar">
          <input className="search-input" placeholder="🔍 Поиск по названию..." value={search} onChange={e => setSearch(e.target.value)} />
          <select className="filter-select" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">Все типы</option>
            {types.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
          <div style={{ marginLeft: 'auto' }}>
            <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Добавить подрядчика</button>
          </div>
        </div>

        <div className="table-scroll">
          {loading ? (
            <div className="loading">Загрузка...</div>
          ) : sortedRows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">🤝</div>
              <h3>Подрядчики не найдены</h3>
              <p>Измените фильтры или добавьте нового подрядчика</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  {SORTABLE_COLUMNS.slice(0, 1).map(col => (
                    <th key={col.key} onClick={() => toggleSort(col.key)} style={{ cursor: 'pointer', userSelect: 'none' }}>
                      {col.label}<SortIcon colKey={col.key} />
                    </th>
                  ))}
                  <th>Тип</th>
                  <th>Статус</th>
                  {SORTABLE_COLUMNS.slice(1).map(col => (
                    <th key={col.key} onClick={() => toggleSort(col.key)} style={{ cursor: 'pointer', userSelect: 'none', textAlign: col.key === 'updated' ? 'left' : 'right' }}>
                      {col.label}<SortIcon colKey={col.key} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map(r => {
                  const fact = periodFact(r.contractor_id)
                  return (
                    <tr key={r.contractor_id}>
                      <td>
                        <span className="td-name" onClick={() => onOpenPassport(r.contractor_id)}>{r.short_name || r.name}</span>
                        {hasDeviationAlert(fact, targets[r.contractor_id], mode) && (
                          <span title="Отклонение >20% от плана за период" style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: 'var(--red)', marginLeft: 7, verticalAlign: 'middle' }} />
                        )}
                      </td>
                      <td className="td-muted">{r.type || '—'}</td>
                      <td><span className={`badge ${getStatusClass(r.status)}`}>{r.status}</span></td>
                      <td style={{ textAlign: 'right' }} className="metric">{fact.leads || 0}</td>
                      <td style={{ textAlign: 'right' }}>{formatMoney(fact.spend)}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span className={`metric ${cplClass(fact.cpl)}`}>{fact.cpl ? formatMoney(fact.cpl) : '—'}</span>
                      </td>
                      <td style={{ textAlign: 'right' }} className="metric">{fact.quals || 0}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span className={`metric ${cpqlClass(fact.cpql)}`}>{fact.cpql ? formatMoney(fact.cpql) : '—'}</span>
                      </td>
                      <td style={{ textAlign: 'right' }} className="metric">{fact.meetings || 0}</td>
                      <td style={{ textAlign: 'right' }} className="metric">{fact.deals || 0}</td>
                      <td className="td-muted" style={{ fontSize: 11 }}>{formatDate(r.updated_at)}</td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showAdd && (
        <AddContractorModal onClose={() => setShowAdd(false)} onSaved={(c) => { setShowAdd(false); load(); onOpenPassport(c.id) }} />
      )}
    </div>
  )
}
