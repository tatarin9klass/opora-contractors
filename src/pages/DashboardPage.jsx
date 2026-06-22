import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatMoney, formatDate, getStatusClass } from '../lib/helpers.js'

// Получить начало недели (понедельник)
function getWeekStart(date = new Date()) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = d.getDate() - day + (day === 0 ? -6 : 1)
  d.setDate(diff)
  return d.toISOString().split('T')[0]
}

function getMonthStart(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`
}

function weekLabel(dateStr) {
  const d = new Date(dateStr)
  const weekNum = getISOWeek(d)
  return `${weekNum} неделя ${d.getFullYear()}`
}

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7)
}

// Подсветка отклонения
function deviationColor(metric, fact, plan) {
  if (!plan || plan === 0) return 'var(--text)'
  const isPositiveMetric = ['leads', 'quals', 'meetings', 'deals', 'cr_lq', 'cr_qm'].includes(metric)
  const isCostMetric = ['spend', 'cpl', 'cpql', 'cac'].includes(metric)
  const better = fact > plan
  if (isPositiveMetric) return better ? 'var(--green-primary)' : 'var(--red)'
  if (isCostMetric) return better ? 'var(--red)' : 'var(--green-primary)'
  return 'var(--text)'
}

function pct(fact, plan) {
  if (!plan || plan === 0) return null
  return Math.round((fact / plan) * 100)
}

function deviation(fact, plan) {
  if (!plan && plan !== 0) return null
  return fact - plan
}

export default function DashboardPage({ onOpenPassport }) {
  const [mode, setMode] = useState('month') // 'month' | 'week'
  const [selectedWeek, setSelectedWeek] = useState(getWeekStart())
  const [allFacts, setAllFacts] = useState([])
  const [contractors, setContractors] = useState([])
  const [target, setTarget] = useState(null)
  const [loading, setLoading] = useState(true)

  // Список доступных недель
  const [availableWeeks, setAvailableWeeks] = useState([])

  useEffect(() => {
    async function load() {
      setLoading(true)
      const [factsRes, contractorsRes, targetRes, weeksRes] = await Promise.all([
        supabase.from('weekly_facts').select('*, contractors(id, name, short_name, contractor_statuses(name, is_active))'),
        supabase.from('contractor_mtd').select('*'),
        supabase.from('monthly_targets').select('*').eq('month', getMonthStart()).maybeSingle(),
        supabase.from('weekly_facts').select('week_start').order('week_start', { ascending: false }),
      ])
      setAllFacts(factsRes.data || [])
      setContractors(contractorsRes.data || [])
      setTarget(targetRes.data || null)
      // уникальные недели
      const weeks = [...new Set((weeksRes.data || []).map(w => w.week_start))].slice(0, 12)
      setAvailableWeeks(weeks)
      setLoading(false)
    }
    load()
  }, [])

  // Агрегация факта
  function aggregate(facts) {
    const spend = facts.reduce((s, f) => s + (f.spend || 0), 0)
    const leads = facts.reduce((s, f) => s + (f.leads || 0), 0)
    const quals = facts.reduce((s, f) => s + (f.quals || 0), 0)
    const meetings = facts.reduce((s, f) => s + (f.meetings || 0), 0)
    const deals = facts.reduce((s, f) => s + (f.deals || 0), 0)
    const cpl = leads > 0 ? Math.round(spend / leads) : null
    const cpql = quals > 0 ? Math.round(spend / quals) : null
    const cac = deals > 0 ? Math.round(spend / deals) : null
    const cr_lq = leads > 0 ? Math.round((quals / leads) * 1000) / 10 : null
    const cr_qm = quals > 0 ? Math.round((meetings / quals) * 1000) / 10 : null
    const cr_mo = meetings > 0 ? Math.round((deals / meetings) * 1000) / 10 : null
    return { spend, leads, quals, meetings, deals, cpl, cpql, cac, cr_lq, cr_qm, cr_mo }
  }

  // Факты за выбранный период
  const periodFacts = mode === 'month'
    ? allFacts.filter(f => f.week_start >= getMonthStart())
    : allFacts.filter(f => f.week_start === selectedWeek)

  const fact = aggregate(periodFacts)

  // Для недельного режима план пропорционален (месяц / 4.33)
  const weekRatio = 1 / 4.33
  function planVal(key) {
    if (!target) return null
    const v = target[`plan_${key}`]
    if (!v) return null
    // для cost-метрик план не масштабируем (CPL план тот же)
    const costMetrics = ['cpl', 'cpql', 'cac', 'cr_lq', 'cr_qm', 'cr_mo']
    if (costMetrics.includes(key)) return v
    return mode === 'week' ? Math.round(v * weekRatio) : v
  }

  // Подрядчики без данных за период
  const contractorIdsWithData = new Set(periodFacts.map(f => f.contractors?.id).filter(Boolean))
  const activeContractors = contractors.filter(c => c.is_active)
  const noDataContractors = activeContractors.filter(c => !contractorIdsWithData.has(c.contractor_id))

  // Зоны внимания: нет плана или CPL превышен
  const alertContractors = activeContractors.filter(c =>
    (c.spend_mtd > 0 && c.leads_mtd === 0) || c.cpl_mtd > 1500
  )

  const periodLabel = mode === 'month'
    ? `Месяц: ${new Date().toLocaleString('ru-RU', { month: 'long', year: 'numeric' })}`
    : `${weekLabel(selectedWeek)}`

  if (loading) return <div className="loading">Загрузка дашборда...</div>

  // KPI карточки верхнего ряда
  const kpiCards = [
    {
      label: 'Расход',
      fact: formatMoney(fact.spend),
      factRaw: fact.spend,
      planRaw: planVal('spend'),
      metric: 'spend',
      format: v => formatMoney(v),
    },
    {
      label: 'Лиды',
      fact: fact.leads,
      factRaw: fact.leads,
      planRaw: planVal('leads'),
      metric: 'leads',
      format: v => v,
    },
    {
      label: 'CPL',
      fact: fact.cpl ? formatMoney(fact.cpl) : '—',
      factRaw: fact.cpl,
      planRaw: planVal('cpl'),
      metric: 'cpl',
      format: v => formatMoney(v),
    },
    {
      label: 'Квалы',
      fact: fact.quals,
      factRaw: fact.quals,
      planRaw: planVal('quals'),
      metric: 'quals',
      format: v => v,
    },
    {
      label: 'CR(l→q)',
      fact: fact.cr_lq ? `${fact.cr_lq}%` : '—',
      factRaw: fact.cr_lq,
      planRaw: planVal('cr_lq'),
      metric: 'cr_lq',
      format: v => `${v}%`,
    },
    {
      label: 'CPQL',
      fact: fact.cpql ? formatMoney(fact.cpql) : '—',
      factRaw: fact.cpql,
      planRaw: planVal('cpql'),
      metric: 'cpql',
      format: v => formatMoney(v),
    },
  ]

  // Дополнительные показатели
  const extraRows = [
    { label: 'Встречи', factRaw: fact.meetings, planKey: 'meetings', metric: 'meetings', format: v => v },
    { label: 'CR(q→m)', factRaw: fact.cr_qm, planKey: 'cr_qm', metric: 'cr_qm', format: v => `${v}%` },
    { label: 'Сделки', factRaw: fact.deals, planKey: 'deals', metric: 'deals', format: v => v },
    { label: 'CAC', factRaw: fact.cac, planKey: 'cac', metric: 'cac', format: v => formatMoney(v) },
    { label: 'CR(m→o)', factRaw: fact.cr_mo, planKey: 'cr_mo', metric: 'cr_mo', format: v => `${v}%` },
  ]

  return (
    <div>
      {/* Шапка */}
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
            ПЛАН / ФАКТ
          </div>
          <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)' }}>
            Дашборд за период: {periodLabel}
          </div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 3 }}>
            Показатели считаются по всем подрядчикам, независимо от статуса
          </div>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 8 }}>
          {/* Переключатель */}
          <div style={{ display: 'flex', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 24, padding: 3 }}>
            <button
              onClick={() => setMode('month')}
              style={{
                padding: '6px 16px', borderRadius: 20, border: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer',
                background: mode === 'month' ? 'var(--green-dark)' : 'transparent',
                color: mode === 'month' ? '#fff' : 'var(--text-secondary)',
                transition: 'all 0.15s'
              }}
            >Месяц</button>
            <button
              onClick={() => setMode('week')}
              style={{
                padding: '6px 16px', borderRadius: 20, border: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer',
                background: mode === 'week' ? 'var(--green-dark)' : 'transparent',
                color: mode === 'week' ? '#fff' : 'var(--text-secondary)',
                transition: 'all 0.15s'
              }}
            >Неделя</button>
          </div>
          {mode === 'week' && (
            <select
              className="form-select"
              style={{ minWidth: 180 }}
              value={selectedWeek}
              onChange={e => setSelectedWeek(e.target.value)}
            >
              {availableWeeks.length === 0 && (
                <option value={getWeekStart()}>{weekLabel(getWeekStart())}</option>
              )}
              {availableWeeks.map(w => (
                <option key={w} value={w}>{weekLabel(w)}</option>
              ))}
            </select>
          )}
        </div>
      </div>

      {/* KPI карточки */}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, 1fr)', gap: 10, marginBottom: 20 }}>
        {kpiCards.map(card => {
          const p = card.planRaw
          const f = card.factRaw
          const pctVal = pct(f, p)
          const dev = deviation(f, p)
          const devColor = deviationColor(card.metric, f, p)
          return (
            <div key={card.label} style={{
              background: 'var(--white)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius-lg)', padding: '16px 14px'
            }}>
              <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', marginBottom: 6 }}>{card.label}</div>
              <div style={{ fontSize: 22, fontWeight: 700, color: 'var(--text)', lineHeight: 1 }}>{card.fact}</div>
              {p != null && (
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)', display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <div>План: {card.format(p)}</div>
                  <div>Выполнение: <span style={{ fontWeight: 600, color: devColor }}>{pctVal}%</span></div>
                  <div>Отклонение: <span style={{ fontWeight: 600, color: devColor }}>
                    {dev > 0 ? '+' : ''}{card.format(Math.round(dev * 10) / 10)}
                  </span></div>
                </div>
              )}
              {!p && (
                <div style={{ marginTop: 8, fontSize: 11, color: 'var(--text-muted)' }}>План не задан</div>
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
                  <th key={h} style={{ textAlign: h === 'Метрика' ? 'left' : 'right', fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', padding: '4px 6px', borderBottom: '1px solid var(--border)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {extraRows.map(row => {
                const p = planVal(row.planKey)
                const f = row.factRaw
                const pctVal = pct(f, p)
                const dev = deviation(f, p)
                const devColor = deviationColor(row.metric, f, p)
                return (
                  <tr key={row.label} style={{ borderBottom: '1px solid var(--border-light)' }}>
                    <td style={{ padding: '8px 6px', fontSize: 12, fontWeight: 500 }}>{row.label}</td>
                    <td style={{ padding: '8px 6px', fontSize: 12, textAlign: 'right', color: 'var(--text-muted)' }}>{p != null ? row.format(p) : '—'}</td>
                    <td style={{ padding: '8px 6px', fontSize: 12, textAlign: 'right', fontWeight: 600 }}>{f != null ? row.format(f) : '—'}</td>
                    <td style={{ padding: '8px 6px', fontSize: 12, textAlign: 'right', fontWeight: 600, color: devColor }}>{pctVal != null ? `${pctVal}%` : '—'}</td>
                    <td style={{ padding: '8px 6px', fontSize: 12, textAlign: 'right', fontWeight: 600, color: devColor }}>
                      {dev != null ? `${dev > 0 ? '+' : ''}${row.format(Math.round(dev * 10) / 10)}` : '—'}
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>

        {/* Зоны внимания */}
        <div style={{ background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Зоны внимания</div>
          {alertContractors.length === 0 && noDataContractors.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)', fontSize: 13 }}>
              ✅ Всё в порядке
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {alertContractors.map(c => (
                <div
                  key={c.contractor_id}
                  onClick={() => onOpenPassport(c.contractor_id)}
                  style={{
                    background: '#fdf2f2', border: '1px solid #f5c6c6',
                    borderRadius: 'var(--radius)', padding: '10px 12px', cursor: 'pointer'
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{c.short_name || c.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 2 }}>
                    {c.cpl_mtd > 1500 && `CPL ${Math.round(c.cpl_mtd).toLocaleString('ru-RU')} ₽ — превышен порог`}
                    {c.spend_mtd > 0 && c.leads_mtd === 0 && 'Расход есть, лидов нет'}
                  </div>
                </div>
              ))}
              {/* Нет плана */}
              {activeContractors.filter(c => !target).slice(0, 3).map(c => (
                <div
                  key={`np-${c.contractor_id}`}
                  onClick={() => onOpenPassport(c.contractor_id)}
                  style={{
                    background: '#fdf2f2', border: '1px solid #f5c6c6',
                    borderRadius: 'var(--radius)', padding: '10px 12px', cursor: 'pointer'
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{c.short_name || c.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--red)', marginTop: 2 }}>Нет плана на период</div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Нет обновления */}
        <div style={{ background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 20 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 14 }}>Нет данных за период</div>
          {noDataContractors.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '24px 0', color: 'var(--text-muted)', fontSize: 13 }}>
              ✅ Все подрядчики обновлены
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {noDataContractors.map(c => (
                <div
                  key={c.contractor_id}
                  onClick={() => onOpenPassport(c.contractor_id)}
                  style={{
                    background: '#fdf2f2', border: '1px solid #f5c6c6',
                    borderRadius: 'var(--radius)', padding: '10px 12px', cursor: 'pointer'
                  }}
                >
                  <div style={{ fontWeight: 600, fontSize: 13 }}>{c.short_name || c.name}</div>
                  <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 2 }}>
                    {mode === 'week' ? `${weekLabel(selectedWeek)} — нет данных` : 'Текущий месяц — нет данных'}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
