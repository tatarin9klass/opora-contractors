import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatMoney } from '../lib/helpers.js'
import { weekStart as getWeekStart, addDaysISO } from '../lib/dateContext.js'
import SetTargetModal from '../components/SetTargetModal.jsx'

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

function deviationColor(metric, fact, plan) {
  if (!plan || plan === 0 || fact == null) return 'var(--text-secondary)'
  const positive = ['leads', 'quals', 'meetings', 'deals', 'cr_lq', 'cr_qm', 'cr_mo', 'cr_lo', 'revenue', 'aov'].includes(metric)
  const cost = ['spend', 'cpl', 'cpql', 'cac', 'cpm'].includes(metric)
  if (positive) return fact >= plan ? 'var(--green-primary)' : 'var(--red)'
  if (cost) return fact <= plan ? 'var(--green-primary)' : 'var(--red)'
  return 'var(--text-secondary)'
}

function pct(fact, plan) {
  if (!plan || plan === 0 || fact == null) return null
  return Math.round((fact / plan) * 100)
}

export default function DashboardPage({ onOpenPassport }) {
  const [mode, setMode] = useState('week')
  const [selectedMonth, setSelectedMonth] = useState(monthKey())
  const [selectedWeek, setSelectedWeek] = useState(getWeekStart())
  const [weeklyStats, setWeeklyStats] = useState([])
  const [contractors, setContractors] = useState([])
  const [contractorTargets, setContractorTargets] = useState({})
  const [target, setTarget] = useState(null)
  const [availableWeeks, setAvailableWeeks] = useState([])
  const [availableMonths, setAvailableMonths] = useState([])
  const [loading, setLoading] = useState(true)
  const [showTargetModal, setShowTargetModal] = useState(false)
  const [frozenRows, setFrozenRows] = useState([])
  const [freezing, setFreezing] = useState(false)

  async function load() {
    setLoading(true)
    const [statsRes, contractorsRes, targetsRes] = await Promise.all([
      // ИСТОЧНИК ПРАВДЫ: weekly_stats (daily_facts + weekly_expenses), не weekly_facts
      supabase.from('weekly_stats').select('*, contractors(id, name, short_name, contractor_statuses(name, is_active))'),
      supabase.from('contractor_mtd').select('*'),
      supabase.from('contractor_targets').select('*'),
    ])
    const stats = statsRes.data || []
    setWeeklyStats(stats)
    setContractors(contractorsRes.data || [])

    const targetsMap = {}
    ;(targetsRes.data || []).forEach(t => { targetsMap[t.contractor_id] = t })
    setContractorTargets(targetsMap)

    const weeks = [...new Set(stats.map(w => w.week_start))].sort((a, b) => b.localeCompare(a))
    setAvailableWeeks(weeks)

    const now = new Date()
    const futureMonths = [0, 1, 2].map(offset => monthKey(new Date(now.getFullYear(), now.getMonth() + offset, 1)))
    const months = [...new Set([...futureMonths, ...weeks.map(w => monthKey(new Date(w)))])].sort((a, b) => b.localeCompare(a))
    setAvailableMonths(months)

    setLoading(false)
  }

  async function loadTarget() {
    const { data } = await supabase.from('monthly_targets').select('*').eq('month', selectedMonth).maybeSingle()
    setTarget(data || null)
  }

  // ТЗ раздел 9: если период заморожен, дашборд читает факт и план из
  // снапшота, а не пересчитывает их заново из live-данных.
  async function loadFrozenState() {
    if (mode === 'week') {
      const { data } = await supabase.from('weekly_snapshots').select('*').eq('week_start', selectedWeek)
      setFrozenRows(data || [])
    } else {
      const { data } = await supabase.from('monthly_snapshots').select('*').eq('month', selectedMonth)
      setFrozenRows(data || [])
    }
  }

  useEffect(() => { load() }, [])
  useEffect(() => { loadTarget() }, [selectedMonth])
  useEffect(() => { loadFrozenState() }, [mode, selectedWeek, selectedMonth])

  function aggregate(rows) {
    const leads = rows.reduce((s, r) => s + (r.leads || 0), 0)
    const quals = rows.reduce((s, r) => s + (r.quals || 0), 0)
    const meetings = rows.reduce((s, r) => s + (r.meetings || 0), 0)
    const deals = rows.reduce((s, r) => s + (r.deals || 0), 0)
    const spend = rows.reduce((s, r) => s + (Number(r.spend) || 0), 0)
    const revenue = rows.reduce((s, r) => s + (Number(r.revenue) || 0), 0)
    const cac = deals > 0 ? Math.round(spend / deals) : null
    return {
      spend, leads, quals, meetings, deals, revenue,
      cpl: leads > 0 ? Math.round(spend / leads) : null,
      cpql: quals > 0 ? Math.round(spend / quals) : null,
      cac,
      cpm: meetings > 0 ? Math.round(spend / meetings) : null,
      cr_lq: leads > 0 ? Math.round((quals / leads) * 1000) / 10 : null,
      cr_qm: quals > 0 ? Math.round((meetings / quals) * 1000) / 10 : null,
      cr_mo: meetings > 0 ? Math.round((deals / meetings) * 1000) / 10 : null,
      cr_lo: leads > 0 ? Math.round((deals / leads) * 1000) / 10 : null,
      aov: deals > 0 ? Math.round(revenue / deals) : null,
    }
  }

  function nextMonth(m) {
    const d = new Date(m)
    d.setMonth(d.getMonth() + 1)
    return monthKey(d)
  }

  const weekRatioForFreeze = 1 / 4.33

  // ТЗ раздел 9: заморозка — ручное действие, фиксирует факты и действовавший
  // на тот момент план по каждому подрядчику навсегда (пока их не разморозит
  // админ явно). Пересчёт при повторной заморозке — сначала удаляем старые
  // строки снапшота за этот период, потом пишем свежие.
  async function freezeWeek() {
    if (!window.confirm(`Заморозить неделю ${weekLabel(selectedWeek)}? Данные и план на этот момент станут неизменными.`)) return
    setFreezing(true)
    await supabase.from('weekly_snapshots').delete().eq('week_start', selectedWeek)
    const rows = weeklyStats.filter(r => r.week_start === selectedWeek)
    const weekEnd = addDaysISO(selectedWeek, 6)
    const inserts = rows.filter(r => r.contractor_id).map(r => {
      const t = contractorTargets[r.contractor_id]
      const leads = r.leads || 0, quals = r.quals || 0, meetings = r.meetings || 0, deals = r.deals || 0
      const spend = Number(r.spend) || 0
      const revenue = Number(r.revenue) || 0
      const proratePlan = v => (v == null ? null : Math.round(v * weekRatioForFreeze))
      return {
        week_start: selectedWeek,
        week_end: weekEnd,
        contractor_id: r.contractor_id,
        contractor_name: r.contractors?.short_name || r.contractors?.name || null,
        leads, quals, meetings, deals, spend, revenue,
        cpl: leads > 0 ? Math.round(spend / leads) : null,
        cpql: quals > 0 ? Math.round(spend / quals) : null,
        cac: deals > 0 ? Math.round(spend / deals) : null,
        plan_spend: proratePlan(t?.plan_spend),
        plan_leads: proratePlan(t?.plan_leads),
        plan_quals: proratePlan(t?.plan_quals),
        plan_meetings: proratePlan(t?.plan_meetings),
        plan_deals: proratePlan(t?.plan_deals),
        frozen_at: new Date().toISOString(),
      }
    })
    if (inserts.length > 0) await supabase.from('weekly_snapshots').insert(inserts)
    setFreezing(false)
    loadFrozenState()
  }

  async function freezeMonth() {
    if (!window.confirm(`Заморозить ${monthLabel(selectedMonth)}? Данные и план на этот момент станут неизменными.`)) return
    setFreezing(true)
    await supabase.from('monthly_snapshots').delete().eq('month', selectedMonth)
    const rows = weeklyStats.filter(r => r.week_start >= selectedMonth && r.week_start < nextMonth(selectedMonth))
    const byContractor = {}
    rows.forEach(r => {
      if (!r.contractor_id) return
      if (!byContractor[r.contractor_id]) {
        byContractor[r.contractor_id] = {
          contractor_id: r.contractor_id,
          contractor_name: r.contractors?.short_name || r.contractors?.name || null,
          leads: 0, quals: 0, meetings: 0, deals: 0, spend: 0, revenue: 0,
        }
      }
      const b = byContractor[r.contractor_id]
      b.leads += r.leads || 0
      b.quals += r.quals || 0
      b.meetings += r.meetings || 0
      b.deals += r.deals || 0
      b.spend += Number(r.spend) || 0
      b.revenue += Number(r.revenue) || 0
    })
    const inserts = Object.values(byContractor).map(b => {
      const t = contractorTargets[b.contractor_id]
      return {
        month: selectedMonth,
        contractor_id: b.contractor_id,
        contractor_name: b.contractor_name,
        leads: b.leads, quals: b.quals, meetings: b.meetings, deals: b.deals, spend: b.spend, revenue: b.revenue,
        cpl: b.leads > 0 ? Math.round(b.spend / b.leads) : null,
        cpql: b.quals > 0 ? Math.round(b.spend / b.quals) : null,
        cac: b.deals > 0 ? Math.round(b.spend / b.deals) : null,
        plan_spend: t?.plan_spend ?? null,
        plan_leads: t?.plan_leads ?? null,
        plan_quals: t?.plan_quals ?? null,
        plan_meetings: t?.plan_meetings ?? null,
        plan_deals: t?.plan_deals ?? null,
        frozen_at: new Date().toISOString(),
      }
    })
    if (inserts.length > 0) await supabase.from('monthly_snapshots').insert(inserts)
    setFreezing(false)
    loadFrozenState()
  }

  async function unfreeze() {
    if (!window.confirm('Разморозить и пересчитать? Это перезапишет зафиксированную историю периода.')) return
    setFreezing(true)
    if (mode === 'week') {
      await supabase.from('weekly_snapshots').delete().eq('week_start', selectedWeek)
    } else {
      await supabase.from('monthly_snapshots').delete().eq('month', selectedMonth)
    }
    setFreezing(false)
    loadFrozenState()
  }

  const isFrozen = frozenRows.length > 0

  const livePeriodRows = mode === 'month'
    ? weeklyStats.filter(r => r.week_start >= selectedMonth && r.week_start < nextMonth(selectedMonth))
    : weeklyStats.filter(r => r.week_start === selectedWeek)

  // Замороженный период — читаем из weekly_snapshots/monthly_snapshots
  // (навсегда зафиксированы на момент заморозки), не из live weekly_stats.
  const periodRows = isFrozen ? frozenRows : livePeriodRows

  const fact = aggregate(periodRows)

  const weekRatio = 1 / 4.33
  const BASE_PLAN_KEYS = ['spend', 'leads', 'quals', 'meetings', 'deals']

  // Только 5 базовых метрик хранятся в target (ТЗ раздел 5.1) — плановые значения
  // производных метрик (CPL/CPQL/CAC/CR) считаются из них теми же формулами,
  // что и факт в aggregate(), а не читаются из отдельных колонок.
  function basePlanVal(key) {
    if (!target) return null
    const v = target[`plan_${key}`]
    if (v == null) return null
    return mode === 'week' ? v * weekRatio : v
  }

  function planVal(key) {
    if (BASE_PLAN_KEYS.includes(key)) {
      const v = basePlanVal(key)
      return v == null ? null : Math.round(v)
    }
    const spend = basePlanVal('spend')
    const leads = basePlanVal('leads')
    const quals = basePlanVal('quals')
    const meetings = basePlanVal('meetings')
    const deals = basePlanVal('deals')
    const cac = deals > 0 ? Math.round(spend / deals) : null
    if (key === 'cpl') return leads > 0 ? Math.round(spend / leads) : null
    if (key === 'cpql') return quals > 0 ? Math.round(spend / quals) : null
    if (key === 'cac') return cac
    if (key === 'cpm') return meetings > 0 ? Math.round(spend / meetings) : null
    if (key === 'cr_lq') return leads > 0 ? Math.round((quals / leads) * 1000) / 10 : null
    if (key === 'cr_qm') return quals > 0 ? Math.round((meetings / quals) * 1000) / 10 : null
    if (key === 'cr_mo') return meetings > 0 ? Math.round((deals / meetings) * 1000) / 10 : null
    if (key === 'cr_lo') return leads > 0 ? Math.round((deals / leads) * 1000) / 10 : null
    // Revenue — единственная производная метрика без формулы из базовых 5:
    // средний чек сделки не вывести из spend/leads/quals/meetings/deals,
    // поэтому план revenue вводится отдельно (monthly_targets.plan_revenue).
    if (key === 'revenue') {
      if (!target || target.plan_revenue == null) return null
      const v = mode === 'week' ? target.plan_revenue * weekRatio : target.plan_revenue
      return Math.round(v)
    }
    if (key === 'aov') {
      if (!target || target.plan_revenue == null || !deals) return null
      const revenuePlan = mode === 'week' ? target.plan_revenue * weekRatio : target.plan_revenue
      return Math.round(revenuePlan / deals)
    }
    return null
  }

  const contractorIdsWithData = new Set(periodRows.map(r => r.contractor_id).filter(Boolean))
  const activeContractors = contractors.filter(c => c.is_active)
  // ТЗ раздел 6.3: "нет данных" = нет лидов. Проверка "не введён расход за
  // прошлую неделю" добавится вместе с разделом "Ввод расходов" (ТЗ раздел 8),
  // когда weekly_expenses станет реально заполняться — до этого момента она
  // флагила бы вообще всех подрядчиков без исключения.
  const noDataContractors = activeContractors.filter(c => !contractorIdsWithData.has(c.contractor_id))

  // ТЗ раздел 6.2: "Зоны внимания" — отклонение >20% от личного плана
  // подрядчика по любой из 5 базовых метрик, с учётом направления (расход —
  // если выше плана; остальные — если ниже).
  const BASE_METRIC_LABELS = { spend: 'Расход', leads: 'Лиды', quals: 'Квалы', meetings: 'Встречи', deals: 'Сделки' }
  const COST_METRICS = new Set(['spend'])
  const DEVIATION_THRESHOLD = 0.2

  function formatMetricVal(key, v) {
    return key === 'spend' ? formatMoney(v) : String(Math.round(v))
  }

  function contractorDeviations(contractorId) {
    const rowsForC = periodRows.filter(r => r.contractor_id === contractorId)
    if (rowsForC.length === 0) return []
    // Замороженный период уже несёт план в самом снапшоте (зафиксирован на
    // момент заморозки, приведён к периоду) — не берём live contractorTargets
    // и не прораториваем повторно.
    const t = isFrozen ? rowsForC[0] : contractorTargets[contractorId]
    if (!t) return []
    const f = aggregate(rowsForC)
    const issues = []
    for (const key of BASE_PLAN_KEYS) {
      const planRaw = t[`plan_${key}`]
      if (planRaw == null) continue
      const planPeriod = isFrozen ? planRaw : (mode === 'week' ? planRaw * weekRatio : planRaw)
      if (!planPeriod) continue
      const factVal = f[key] || 0
      const dev = (factVal - planPeriod) / planPeriod
      const isBad = COST_METRICS.has(key) ? dev > DEVIATION_THRESHOLD : dev < -DEVIATION_THRESHOLD
      if (isBad) {
        issues.push({
          key,
          label: BASE_METRIC_LABELS[key],
          devPct: Math.round(dev * 100),
          factDisplay: formatMetricVal(key, factVal),
          planDisplay: formatMetricVal(key, planPeriod),
        })
      }
    }
    return issues
  }

  const alertContractors = activeContractors
    .map(c => ({ c, issues: contractorDeviations(c.contractor_id) }))
    .filter(x => x.issues.length > 0)

  const periodLabel = mode === 'month' ? monthLabel(selectedMonth) : weekLabel(selectedWeek)

  if (loading) return <div className="loading">Загрузка дашборда...</div>

  function fmtDev(factRaw, planRaw, formatFn) {
    if (planRaw == null || factRaw == null) return null
    const dev = factRaw - planRaw
    const sign = dev > 0 ? '+' : ''
    return `${sign}${formatFn(Math.round(dev * 10) / 10)}`
  }

  const kpiCards = [
    { label: 'Расход', key: 'spend', factRaw: fact.spend, format: v => formatMoney(v), display: formatMoney(fact.spend) },
    { label: 'Лиды', key: 'leads', factRaw: fact.leads, format: v => v, display: fact.leads },
    { label: 'CPL', key: 'cpl', factRaw: fact.cpl, format: v => formatMoney(v), display: fact.cpl ? formatMoney(fact.cpl) : '—' },
    { label: 'Квалы', key: 'quals', factRaw: fact.quals, format: v => v, display: fact.quals },
    { label: 'CR(l→q)', key: 'cr_lq', factRaw: fact.cr_lq, format: v => `${v}%`, display: fact.cr_lq ? `${fact.cr_lq}%` : '—' },
    { label: 'CPQL', key: 'cpql', factRaw: fact.cpql, format: v => formatMoney(v), display: fact.cpql ? formatMoney(fact.cpql) : '—' },
  ]

  const extraRows = [
    { label: 'Meeting', key: 'meetings', factRaw: fact.meetings, format: v => v },
    { label: 'CR(q→m)', key: 'cr_qm', factRaw: fact.cr_qm, format: v => `${v}%` },
    { label: 'CPM', key: 'cpm', factRaw: fact.cpm, format: v => formatMoney(v) },
    { label: 'Orders', key: 'deals', factRaw: fact.deals, format: v => v },
    { label: 'CAC', key: 'cac', factRaw: fact.cac, format: v => formatMoney(v) },
    { label: 'CR(l→o)', key: 'cr_lo', factRaw: fact.cr_lo, format: v => `${v}%` },
    { label: 'Revenue', key: 'revenue', factRaw: fact.revenue, format: v => formatMoney(v) },
    { label: 'AOV', key: 'aov', factRaw: fact.aov, format: v => formatMoney(v) },
  ]

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
            ПЛАН / ФАКТ
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, display: 'flex', alignItems: 'center', gap: 10 }}>
            Дашборд за период: {periodLabel}
            {isFrozen && (
              <span style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 20, padding: '3px 10px' }}>
                🔒 Заморожено
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
            Показатели считаются по всем подрядчикам, независимо от статуса
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
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

          {mode === 'month' && (
            <button className="btn btn-secondary btn-sm" onClick={() => setShowTargetModal(true)}>
              {target ? '✏️ Редактировать план' : '+ Задать план'}
            </button>
          )}

          {isFrozen ? (
            <button className="btn btn-secondary btn-sm" onClick={unfreeze} disabled={freezing}>
              {freezing ? '...' : '🔓 Разморозить и пересчитать'}
            </button>
          ) : (
            <button className="btn btn-secondary btn-sm" onClick={mode === 'week' ? freezeWeek : freezeMonth} disabled={freezing}>
              {freezing ? '...' : '🔒 Заморозить период'}
            </button>
          )}
        </div>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 20 }}>
        {kpiCards.map(card => {
          const p = planVal(card.key)
          const f = card.factRaw
          const pctVal = pct(f, p)
          const devColor = deviationColor(card.key, f, p)
          const devStr = fmtDev(f, p, card.format)
          return (
            <div key={card.label} style={{ background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: '16px 14px' }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>{card.label}</div>
              <div style={{ fontSize: 22, fontWeight: 700, lineHeight: 1 }}>{card.display}</div>
              {p != null ? (
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div>План: {card.format(p)}</div>
                  <div>Выполнение: <span style={{ fontWeight: 700, color: devColor }}>{pctVal}%</span></div>
                  <div>Отклонение: <span style={{ fontWeight: 700, color: devColor }}>{devStr}</span></div>
                </div>
              ) : (
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>—</div>
              )}
            </div>
          )
        })}
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
        <div style={{ background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Дополнительные показатели</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Метрика', 'План', 'Факт', '% вып.', 'Откл.'].map(h => (
                  <th key={h} style={{ textAlign: h === 'Метрика' ? 'left' : 'right', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', padding: '4px 6px', borderBottom: '1px solid var(--border)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {extraRows.map(row => {
                const p = planVal(row.key)
                const f = row.factRaw
                const pctVal = pct(f, p)
                const devColor = deviationColor(row.key, f, p)
                const devStr = fmtDev(f, p, row.format)
                return (
                  <tr key={row.label} style={{ borderBottom: '1px solid var(--border-light)' }}>
                    <td style={{ padding: '8px 6px', fontSize: 12, fontWeight: 500 }}>{row.label}</td>
                    <td style={{ padding: '8px 6px', fontSize: 12, textAlign: 'right', color: 'var(--text-muted)' }}>{p != null ? row.format(p) : '—'}</td>
                    <td style={{ padding: '8px 6px', fontSize: 12, textAlign: 'right', fontWeight: 600 }}>{f != null ? row.format(f) : '—'}</td>
                    <td style={{ padding: '8px 6px', fontSize: 12, textAlign: 'right', fontWeight: 700, color: devColor }}>{pctVal != null ? `${pctVal}%` : '—'}</td>
                    <td style={{ padding: '8px 6px', fontSize: 12, textAlign: 'right', fontWeight: 700, color: devColor }}>{devStr || '—'}</td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        <div style={{ background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Зоны внимания</div>
          {alertContractors.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)', fontSize: 13 }}>✅ Всё в порядке</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {alertContractors.map(({ c, issues }) => (
                <div key={c.contractor_id} onClick={() => onOpenPassport(c.contractor_id)} style={{ background: '#fdf2f2', border: '1px solid #f5c6c6', borderRadius: 'var(--radius)', padding: '10px 12px', cursor: 'pointer' }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{c.short_name || c.name}</div>
                  {issues.map(i => (
                    <div key={i.key} style={{ fontSize: 11, color: 'var(--red)', marginTop: 2 }}>
                      {i.label}: {i.devPct > 0 ? '+' : ''}{i.devPct}% ({i.factDisplay} из {i.planDisplay})
                    </div>
                  ))}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Нет данных за период</div>
          {noDataContractors.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)', fontSize: 13 }}>✅ Все подрядчики обновлены</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {noDataContractors.map(c => (
                <div key={c.contractor_id} onClick={() => onOpenPassport(c.contractor_id)} style={{ background: '#fdf2f2', border: '1px solid #f5c6c6', borderRadius: 'var(--radius)', padding: '10px 12px', cursor: 'pointer' }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{c.short_name || c.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {mode === 'week' ? `${weekLabel(selectedWeek)} — нет данных` : `${monthLabel(selectedMonth)} — нет данных`}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {showTargetModal && (
        <SetTargetModal month={selectedMonth} existing={target} onClose={() => setShowTargetModal(false)} onSaved={() => { setShowTargetModal(false); loadTarget() }} />
      )}
    </div>
  )
}
