import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatMoney, formatDate, getStatusClass } from '../lib/helpers.js'
import SetTargetModal from '../components/SetTargetModal.jsx'

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7)
}

function getWeekStart(date = new Date()) {
  // Отчётная неделя Опоры: чт–ср
  const d = new Date(date)
  const day = d.getDay()
  const diff = day >= 4 ? -(day - 4) : -(day + 3)
  d.setDate(d.getDate() + diff)
  return d.toISOString().split('T')[0]
}

function weekLabel(dateStr) {
  const d = new Date(dateStr)
  return `${getISOWeek(d)} неделя ${d.getFullYear()}`
}

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`
}

function monthLabel(dateStr) {
  return new Date(dateStr).toLocaleString('ru-RU', { month: 'long', year: 'numeric' })
}

function deviationColor(metric, fact, plan) {
  if (!plan || plan === 0 || fact == null) return 'var(--text-secondary)'
  const positive = ['leads', 'quals', 'meetings', 'deals', 'cr_lq', 'cr_qm', 'cr_mo'].includes(metric)
  const cost = ['spend', 'cpl', 'cpql', 'cac'].includes(metric)
  if (positive) return fact >= plan ? 'var(--green-primary)' : 'var(--red)'
  if (cost) return fact <= plan ? 'var(--green-primary)' : 'var(--red)'
  return 'var(--text-secondary)'
}

function pct(fact, plan) {
  if (!plan || plan === 0 || fact == null) return null
  return Math.round((fact / plan) * 100)
}

export default function DashboardPage({ onOpenPassport }) {
  const [mode, setMode] = useState('month')
  const [selectedMonth, setSelectedMonth] = useState(monthKey())
  const [selectedWeek, setSelectedWeek] = useState(getWeekStart())
  const [allFacts, setAllFacts] = useState([])
  const [contractors, setContractors] = useState([])
  const [target, setTarget] = useState(null)
  const [availableWeeks, setAvailableWeeks] = useState([])
  const [availableMonths, setAvailableMonths] = useState([])
  const [loading, setLoading] = useState(true)
  const [showTargetModal, setShowTargetModal] = useState(false)

  async function load() {
    setLoading(true)
    const [factsRes, contractorsRes, weeksRes] = await Promise.all([
      supabase.from('weekly_facts').select('*, contractors(id, name, short_name, contractor_statuses(name, is_active))'),
      supabase.from('contractor_mtd').select('*'),
      supabase.from('weekly_facts').select('week_start').order('week_start', { ascending: false }),
    ])
    setAllFacts(factsRes.data || [])
    setContractors(contractorsRes.data || [])

    // Уникальные недели
    const weeks = [...new Set((weeksRes.data || []).map(w => w.week_start))]
    setAvailableWeeks(weeks)

    // Текущий + 2 вперёд + все прошлые с данными
    const now = new Date()
    const futureMonths = [0, 1, 2].map(offset => {
      const d = new Date(now.getFullYear(), now.getMonth() + offset, 1)
      return monthKey(d)
    })
    const months = [...new Set([
      ...futureMonths,
      ...weeks.map(w => monthKey(new Date(w)))
    ])].sort((a, b) => b.localeCompare(a))
    setAvailableMonths(months)

    setLoading(false)
  }

  async function loadTarget() {
    const { data } = await supabase
      .from('monthly_targets')
      .select('*')
      .eq('month', selectedMonth)
      .maybeSingle()
    setTarget(data || null)
  }

  useEffect(() => { load() }, [])
  useEffect(() => { loadTarget() }, [selectedMonth])

  function aggregate(facts) {
    const spend = facts.reduce((s, f) => s + (f.spend || 0), 0)
    const leads = facts.reduce((s, f) => s + (f.leads || 0), 0)
    const quals = facts.reduce((s, f) => s + (f.quals || 0), 0)
    const meetings = facts.reduce((s, f) => s + (f.meetings || 0), 0)
    const deals = facts.reduce((s, f) => s + (f.deals || 0), 0)
    return {
      spend, leads, quals, meetings, deals,
      cpl: leads > 0 ? Math.round(spend / leads) : null,
      cpql: quals > 0 ? Math.round(spend / quals) : null,
      cac: deals > 0 ? Math.round(spend / deals) : null,
      cr_lq: leads > 0 ? Math.round((quals / leads) * 1000) / 10 : null,
      cr_qm: quals > 0 ? Math.round((meetings / quals) * 1000) / 10 : null,
      cr_mo: meetings > 0 ? Math.round((deals / meetings) * 1000) / 10 : null,
    }
  }

  const periodFacts = mode === 'month'
    ? allFacts.filter(f => f.week_start >= selectedMonth && f.week_start < nextMonth(selectedMonth))
    : allFacts.filter(f => f.week_start === selectedWeek)

  function nextMonth(m) {
    const d = new Date(m)
    d.setMonth(d.getMonth() + 1)
    return monthKey(d)
  }

  const fact = aggregate(periodFacts)

  const weekRatio = 1 / 4.33
  function planVal(key) {
    if (!target) return null
    const v = target[`plan_${key}`]
    if (v == null) return null
    const costMetrics = ['cpl', 'cpql', 'cac', 'cr_lq', 'cr_qm', 'cr_mo']
    return mode === 'week' && !costMetrics.includes(key) ? Math.round(v * weekRatio) : v
  }

  const contractorIdsWithData = new Set(periodFacts.map(f => f.contractors?.id).filter(Boolean))
  const activeContractors = contractors.filter(c => c.is_active)
  const noDataContractors = activeContractors.filter(c => !contractorIdsWithData.has(c.contractor_id))
  const alertContractors = activeContractors.filter(c =>
    (c.spend_mtd > 0 && c.leads_mtd === 0) || c.cpl_mtd > 1500
  )

  const periodLabel = mode === 'month'
    ? monthLabel(selectedMonth)
    : weekLabel(selectedWeek)

  if (loading) return <div className="loading">Загрузка дашборда...</div>

  function fmtDev(metric, factRaw, planRaw, formatFn) {
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
    { label: 'Встречи', key: 'meetings', factRaw: fact.meetings, format: v => v },
    { label: 'CR(q→m)', key: 'cr_qm', factRaw: fact.cr_qm, format: v => `${v}%` },
    { label: 'Сделки', key: 'deals', factRaw: fact.deals, format: v => v },
    { label: 'CAC', key: 'cac', factRaw: fact.cac, format: v => formatMoney(v) },
    { label: 'CR(m→o)', key: 'cr_mo', factRaw: fact.cr_mo, format: v => `${v}%` },
  ]

  return (
    <div>
      {/* Шапка */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
            ПЛАН / ФАКТ
          </div>
          <div style={{ fontSize: 22, fontWeight: 700 }}>
            Дашборд за период: {periodLabel}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
            Показатели считаются по всем подрядчикам, независимо от статуса
          </div>
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          {/* Переключатель */}
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

          {/* Выбор периода */}
          {mode === 'month' ? (
            <select className="form-select" style={{ minWidth: 200 }} value={selectedMonth} onChange={e => setSelectedMonth(e.target.value)}>
              {availableMonths.map(m => (
                <option key={m} value={m}>{monthLabel(m)}</option>
              ))}
            </select>
          ) : (
            <select className="form-select" style={{ minWidth: 200 }} value={selectedWeek} onChange={e => setSelectedWeek(e.target.value)}>
              {availableWeeks.length === 0
                ? <option value={getWeekStart()}>{weekLabel(getWeekStart())} (текущая)</option>
                : availableWeeks.map(w => <option key={w} value={w}>{weekLabel(w)}</option>)
              }
            </select>
          )}

          {/* Кнопка плана */}
          {mode === 'month' && (
            <button className="btn btn-secondary btn-sm" onClick={() => setShowTargetModal(true)}>
              {target ? '✏️ Редактировать план' : '+ Задать план'}
            </button>
          )}
        </div>
      </div>

      {/* KPI карточки */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 20 }}>
        {kpiCards.map(card => {
          const p = planVal(card.key)
          const f = card.factRaw
          const pctVal = pct(f, p)
          const devColor = deviationColor(card.key, f, p)
          const devStr = fmtDev(card.key, f, p, card.format)
          return (
            <div key={card.label} style={{
              background: 'var(--white)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)', padding: '16px 14px'
            }}>
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

      {/* Три колонки */}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>

        {/* Дополнительные показатели */}
        <div style={{ background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Дополнительные показатели</div>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                {['Метрика', 'План', 'Факт', '% вып.', 'Откл.'].map(h => (
                  <th key={h} style={{
                    textAlign: h === 'Метрика' ? 'left' : 'right',
                    fontSize: 10, fontWeight: 600, color: 'var(--text-muted)',
                    textTransform: 'uppercase', padding: '4px 6px',
                    borderBottom: '1px solid var(--border)'
                  }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {extraRows.map(row => {
                const p = planVal(row.key)
                const f = row.factRaw
                const pctVal = pct(f, p)
                const devColor = deviationColor(row.key, f, p)
                const devStr = fmtDev(row.key, f, p, row.format)
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

        {/* Зоны внимания */}
        <div style={{ background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Зоны внимания</div>
          {alertContractors.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)', fontSize: 13 }}>✅ Всё в порядке</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {alertContractors.map(c => (
                <div key={c.contractor_id} onClick={() => onOpenPassport(c.contractor_id)} style={{
                  background: '#fdf2f2', border: '1px solid #f5c6c6',
                  borderRadius: 'var(--radius)', padding: '10px 12px', cursor: 'pointer'
                }}>
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{c.short_name || c.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 2 }}>
                    {c.cpl_mtd > 1500 && `CPL ${Math.round(c.cpl_mtd).toLocaleString('ru-RU')} ₽ — превышен порог`}
                    {c.spend_mtd > 0 && c.leads_mtd === 0 && 'Расход есть, лидов нет'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Нет данных за период */}
        <div style={{ background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Нет данных за период</div>
          {noDataContractors.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)', fontSize: 13 }}>✅ Все подрядчики обновлены</div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {noDataContractors.map(c => (
                <div key={c.contractor_id} onClick={() => onOpenPassport(c.contractor_id)} style={{
                  background: '#fdf2f2', border: '1px solid #f5c6c6',
                  borderRadius: 'var(--radius)', padding: '10px 12px', cursor: 'pointer'
                }}>
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
        <SetTargetModal
          month={selectedMonth}
          existing={target}
          onClose={() => setShowTargetModal(false)}
          onSaved={() => { setShowTargetModal(false); loadTarget() }}
        />
      )}
    </div>
  )
}
