import React, { useState, useEffect, useMemo } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { supabase } from '../lib/supabase.js'
import { getStatusClass, cplClass, cpqlClass, cacClass, formatMoney } from '../lib/helpers.js'
import { weekStart as getWeekStart, todayISO, periodPaceRatio } from '../lib/dateContext.js'
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

// paceRatio — доля текущей недели/месяца, которая уже прошла (1 для уже
// завершившегося периода) — план сравнивается не с целым периодом, а с тем,
// что должно было накопиться к сегодняшнему дню, иначе 1 числа месяца план
// всегда выглядит проваленным.
function hasDeviationAlert(fact, target, mode, paceRatio) {
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
    const planPeriodFull = mode === 'week' ? planRaw * WEEK_RATIO : planRaw
    if (!planPeriodFull) return false
    const planPeriod = planPeriodFull * paceRatio
    if (!planPeriod) return false
    const dev = ((factVal || 0) - planPeriod) / planPeriod
    return DEVIATION_COST_METRICS.has(key) ? dev > DEVIATION_THRESHOLD : dev < -DEVIATION_THRESHOLD
  })
}

export default function ContractorsPage({ onOpenPassport, isAdmin }) {
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
  const [dailyFacts, setDailyFacts] = useState([])
  const [monthlyTarget, setMonthlyTarget] = useState(null)

  async function load() {
    setLoading(true)
    const currentMonth = monthKey()
    const [{ data }, { data: targetRows }, { data: statsRows }, { data: dailyRows }, { data: mTarget }] = await Promise.all([
      supabase.from('contractor_mtd').select('*'),
      supabase.from('contractor_targets').select('*'),
      supabase.from('weekly_stats').select('*'),
      // График "Лиды/Квалы/Встречи по дням" — всегда текущий календарный месяц,
      // независимо от переключателя Месяц/Неделя вверху страницы (план на день
      // считается только от текущего месяца).
      supabase.from('daily_facts').select('fact_date, leads, quals, meetings').not('contractor_id', 'is', null).gte('fact_date', currentMonth).lte('fact_date', todayISO()),
      supabase.from('monthly_targets').select('*').eq('month', currentMonth).maybeSingle(),
    ])
    setRows(data || [])
    setDailyFacts(dailyRows || [])
    setMonthlyTarget(mTarget || null)
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
    if (!periodByContractor[r.contractor_id]) periodByContractor[r.contractor_id] = { leads: 0, quals: 0, meetings: 0, deals: 0, spend: 0, revenue: 0 }
    const a = periodByContractor[r.contractor_id]
    a.leads += r.leads || 0
    a.quals += r.quals || 0
    a.meetings += r.meetings || 0
    a.deals += r.deals || 0
    a.spend += Number(r.spend) || 0
    a.revenue += Number(r.revenue) || 0
  })

  // Считает CPL/CPQL/CPM/CAC/CR% из суммарных чисел — та же формула, что и
  // в aggregate() на дашборде (отношение сумм, а не среднее по строкам).
  function deriveRates(a) {
    return {
      cpl: a.leads > 0 ? Math.round(a.spend / a.leads) : null,
      cpql: a.quals > 0 ? Math.round(a.spend / a.quals) : null,
      cpm: a.meetings > 0 ? Math.round(a.spend / a.meetings) : null,
      cac: a.deals > 0 ? Math.round(a.spend / a.deals) : null,
      cr_lq: a.leads > 0 ? Math.round((a.quals / a.leads) * 1000) / 10 : null,
      cr_qm: a.quals > 0 ? Math.round((a.meetings / a.quals) * 1000) / 10 : null,
      cr_lo: a.leads > 0 ? Math.round((a.deals / a.leads) * 1000) / 10 : null,
    }
  }

  function periodFact(contractorId) {
    const a = periodByContractor[contractorId] || { leads: 0, quals: 0, meetings: 0, deals: 0, spend: 0, revenue: 0 }
    return { ...a, ...deriveRates(a) }
  }

  // Итоговая строка таблицы — те же суммарные цифры за период, что и на
  // дашборде (aggregate(periodRows) по ВСЕМ подрядчикам), а не только по
  // отфильтрованным строкам этой таблицы.
  const totalsRaw = periodRows.reduce((acc, r) => {
    acc.spend += Number(r.spend) || 0
    acc.leads += r.leads || 0
    acc.quals += r.quals || 0
    acc.meetings += r.meetings || 0
    acc.deals += r.deals || 0
    acc.revenue += Number(r.revenue) || 0
    return acc
  }, { spend: 0, leads: 0, quals: 0, meetings: 0, deals: 0, revenue: 0 })
  const totalsFact = { ...totalsRaw, ...deriveRates(totalsRaw) }

  const periodLabel = mode === 'month' ? monthLabel(selectedMonth) : weekLabel(selectedWeek)
  const paceRatio = periodPaceRatio(mode, mode === 'week' ? selectedWeek : selectedMonth)

  // График "Лиды/Квалы/Встречи по дням" (текущий месяц, суммарно по всем
  // подрядчикам) + линия "план на день по квалам" — план на месяц минус уже
  // полученные квалы, делённый на оставшиеся календарные дни месяца.
  const dailySeries = useMemo(() => {
    const byDay = {}
    for (const r of dailyFacts) {
      if (!byDay[r.fact_date]) byDay[r.fact_date] = { fact_date: r.fact_date, leads: 0, quals: 0, meetings: 0 }
      byDay[r.fact_date].leads += r.leads || 0
      byDay[r.fact_date].quals += r.quals || 0
      byDay[r.fact_date].meetings += r.meetings || 0
    }
    const today = new Date()
    const daysInMonth = new Date(today.getFullYear(), today.getMonth() + 1, 0).getDate()
    const remainingDays = daysInMonth - today.getDate()
    const qualsSoFar = Object.values(byDay).reduce((s, d) => s + d.quals, 0)
    const qualsRemaining = Math.max(0, (monthlyTarget?.plan_quals || 0) - qualsSoFar)
    const planPerDay = monthlyTarget?.plan_quals && remainingDays > 0 ? Math.round(qualsRemaining / remainingDays) : null
    return Object.keys(byDay).sort().map(fact_date => ({
      ...byDay[fact_date],
      xLabel: new Date(fact_date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }),
      plan_per_day: planPerDay,
    }))
  }, [dailyFacts, monthlyTarget])

  const SORTABLE_COLUMNS = [
    { key: 'name', label: 'Подрядчик', field: r => (r.short_name || r.name || '').toLowerCase() },
    { key: 'spend', label: 'Расход', field: r => periodFact(r.contractor_id).spend },
    { key: 'leads', label: 'Лиды', field: r => periodFact(r.contractor_id).leads },
    { key: 'cpl', label: 'CPL', field: r => periodFact(r.contractor_id).cpl ?? -1 },
    { key: 'quals', label: 'Квалы', field: r => periodFact(r.contractor_id).quals },
    { key: 'cr_lq', label: 'CR(l→q)', field: r => periodFact(r.contractor_id).cr_lq ?? -1 },
    { key: 'cpql', label: 'CPQL', field: r => periodFact(r.contractor_id).cpql ?? -1 },
    { key: 'meetings', label: 'Встречи', field: r => periodFact(r.contractor_id).meetings },
    { key: 'cpm', label: 'CPM', field: r => periodFact(r.contractor_id).cpm ?? -1 },
    { key: 'cr_qm', label: 'CR(q→m)', field: r => periodFact(r.contractor_id).cr_qm ?? -1 },
    { key: 'deals', label: 'Сделки', field: r => periodFact(r.contractor_id).deals },
    { key: 'cac', label: 'CAC', field: r => periodFact(r.contractor_id).cac ?? -1 },
    { key: 'cr_lo', label: 'CR(l→o)', field: r => periodFact(r.contractor_id).cr_lo ?? -1 },
    { key: 'revenue', label: 'Revenue', field: r => periodFact(r.contractor_id).revenue },
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
  const alertCount = rows.filter(r => r.is_active && hasDeviationAlert(periodFact(r.contractor_id), targets[r.contractor_id], mode, paceRatio)).length

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

      <div style={{ background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 20, marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Лиды, квалы и встречи по дням — {monthLabel(monthKey())}</div>
        {dailySeries.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 13 }}>Нет данных за текущий месяц</div>
        ) : (
          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={dailySeries} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#dce8d8" />
              <XAxis dataKey="xLabel" tick={{ fontSize: 11, fill: '#8a9590' }} />
              <YAxis tick={{ fontSize: 11, fill: '#8a9590' }} width={40} />
              <Tooltip />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="leads" name="Лиды" stroke="#8a9590" strokeWidth={2} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="quals" name="Квалы" stroke="#3A7E34" strokeWidth={2} dot={{ r: 3 }} />
              <Line type="monotone" dataKey="meetings" name="Встречи" stroke="#1f3b27" strokeWidth={2} dot={{ r: 3 }} />
              {dailySeries[0]?.plan_per_day != null && (
                <Line type="monotone" dataKey="plan_per_day" name="План на день (квалы)" stroke="#d93025" strokeWidth={1.5} strokeDasharray="5 4" dot={false} />
              )}
            </LineChart>
          </ResponsiveContainer>
        )}
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
          {isAdmin && (
            <div style={{ marginLeft: 'auto' }}>
              <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Добавить подрядчика</button>
            </div>
          )}
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
            <table className="table-compact">
              <thead>
                <tr>
                  {SORTABLE_COLUMNS.slice(0, 1).map(col => (
                    <th key={col.key} onClick={() => toggleSort(col.key)} style={{ cursor: 'pointer', userSelect: 'none' }}>
                      {col.label}<SortIcon colKey={col.key} />
                    </th>
                  ))}
                  <th>Статус</th>
                  {SORTABLE_COLUMNS.slice(1).map(col => (
                    <th key={col.key} onClick={() => toggleSort(col.key)} style={{ cursor: 'pointer', userSelect: 'none', textAlign: 'right' }}>
                      {col.label}<SortIcon colKey={col.key} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                <tr style={{ background: 'var(--green-bg)', fontWeight: 600 }}>
                  <td>Итого / Среднее</td>
                  <td>—</td>
                  <td style={{ textAlign: 'right' }}>{formatMoney(totalsFact.spend)}</td>
                  <td style={{ textAlign: 'right' }}>{totalsFact.leads}</td>
                  <td style={{ textAlign: 'right' }}>{totalsFact.cpl ? formatMoney(totalsFact.cpl) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{totalsFact.quals}</td>
                  <td style={{ textAlign: 'right' }}>{totalsFact.cr_lq != null ? `${totalsFact.cr_lq}%` : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{totalsFact.cpql ? formatMoney(totalsFact.cpql) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{totalsFact.meetings}</td>
                  <td style={{ textAlign: 'right' }}>{totalsFact.cpm ? formatMoney(totalsFact.cpm) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{totalsFact.cr_qm != null ? `${totalsFact.cr_qm}%` : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{totalsFact.deals}</td>
                  <td style={{ textAlign: 'right' }}>{totalsFact.cac ? formatMoney(totalsFact.cac) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{totalsFact.cr_lo != null ? `${totalsFact.cr_lo}%` : '—'}</td>
                  <td style={{ textAlign: 'right' }}>{totalsFact.revenue ? formatMoney(totalsFact.revenue) : '—'}</td>
                </tr>
                {sortedRows.map(r => {
                  const fact = periodFact(r.contractor_id)
                  return (
                    <tr key={r.contractor_id}>
                      <td>
                        <span className="td-name" onClick={() => onOpenPassport(r.contractor_id)}>{r.short_name || r.name}</span>
                        {hasDeviationAlert(fact, targets[r.contractor_id], mode, paceRatio) && (
                          <span title="Отклонение >20% от плана за период" style={{ display: 'inline-block', width: 7, height: 7, borderRadius: '50%', background: 'var(--red)', marginLeft: 7, verticalAlign: 'middle' }} />
                        )}
                      </td>
                      <td><span className={`badge ${getStatusClass(r.status)}`}>{r.status}</span></td>
                      <td style={{ textAlign: 'right' }}>{formatMoney(fact.spend)}</td>
                      <td style={{ textAlign: 'right' }} className="metric">{fact.leads || 0}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span className={`metric ${cplClass(fact.cpl)}`}>{fact.cpl ? formatMoney(fact.cpl) : '—'}</span>
                      </td>
                      <td style={{ textAlign: 'right' }} className="metric">{fact.quals || 0}</td>
                      <td style={{ textAlign: 'right' }} className="td-muted">{fact.cr_lq != null ? `${fact.cr_lq}%` : '—'}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span className={`metric ${cpqlClass(fact.cpql)}`}>{fact.cpql ? formatMoney(fact.cpql) : '—'}</span>
                      </td>
                      <td style={{ textAlign: 'right' }} className="metric">{fact.meetings || 0}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span className="metric">{fact.cpm ? formatMoney(fact.cpm) : '—'}</span>
                      </td>
                      <td style={{ textAlign: 'right' }} className="td-muted">{fact.cr_qm != null ? `${fact.cr_qm}%` : '—'}</td>
                      <td style={{ textAlign: 'right' }} className="metric">{fact.deals || 0}</td>
                      <td style={{ textAlign: 'right' }}>
                        <span className={`metric ${cacClass(fact.cac)}`}>{fact.cac ? formatMoney(fact.cac) : '—'}</span>
                      </td>
                      <td style={{ textAlign: 'right' }} className="td-muted">{fact.cr_lo != null ? `${fact.cr_lo}%` : '—'}</td>
                      <td style={{ textAlign: 'right' }}>{fact.revenue ? formatMoney(fact.revenue) : '—'}</td>
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
