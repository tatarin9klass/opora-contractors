import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatMoney } from '../lib/helpers.js'
import { periodPaceRatio } from '../lib/dateContext.js'

// Компания целиком, по неделям, план vs факт по всем метрикам сразу — как в
// таблице "Регулярный менеджмент", которую вели раньше вручную. Каждая
// метрика — ровно 3 строки (отклонение / План / Факт), недели — столбцы.
// Первый столбец (название метрики) и шапка (номера недель) закреплены, как
// при заморозке областей в Excel/Google Sheets.

const WEEK_RATIO = 1 / 4.33

function getISOWeek(dateStr) {
  const d = new Date(`${dateStr}T12:00:00Z`)
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7)
}

function monthKeyOf(dateStr) {
  const d = new Date(dateStr)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`
}

// Считает CPL/CPQL/CPM/CAC/CR%/AOV из суммарных чисел — та же формула, что и
// на дашборде (отношение сумм, не среднее по строкам).
function deriveRates(a) {
  return {
    cpl: a.leads > 0 ? Math.round(a.spend / a.leads) : null,
    cpql: a.quals > 0 ? Math.round(a.spend / a.quals) : null,
    cpm: a.meetings > 0 ? Math.round(a.spend / a.meetings) : null,
    cac: a.deals > 0 ? Math.round(a.spend / a.deals) : null,
    cr_lq: a.leads > 0 ? Math.round((a.quals / a.leads) * 1000) / 10 : null,
    cr_qm: a.quals > 0 ? Math.round((a.meetings / a.quals) * 1000) / 10 : null,
    cr_lo: a.leads > 0 ? Math.round((a.deals / a.leads) * 1000) / 10 : null,
    aov: a.deals > 0 ? Math.round(a.revenue / a.deals) : null,
  }
}

// kind определяет формат строки отклонения: count → "% выполнения",
// rate → "< / > на N ₽", ratio → разница в п.п. goodWhen — куда должен
// отклоняться факт, чтобы это было хорошо (расход и стоимостные метрики —
// "lower", всё остальное, включая AOV, — "higher").
const METRIC_GROUPS = [
  { key: 'spend', label: 'Расход', format: formatMoney, kind: 'count', goodWhen: 'lower' },
  { key: 'leads', label: 'Лиды', format: v => String(v), kind: 'count', goodWhen: 'higher' },
  { key: 'cpl', label: 'CPL', format: formatMoney, kind: 'rate', goodWhen: 'lower' },
  { key: 'quals', label: 'Квалы', format: v => String(v), kind: 'count', goodWhen: 'higher' },
  { key: 'cr_lq', label: 'CR(l→q)', format: v => `${v}%`, kind: 'ratio', goodWhen: 'higher' },
  { key: 'cpql', label: 'CPQL', format: formatMoney, kind: 'rate', goodWhen: 'lower' },
  { key: 'meetings', label: 'Встречи', format: v => String(v), kind: 'count', goodWhen: 'higher' },
  { key: 'cpm', label: 'CPM', format: formatMoney, kind: 'rate', goodWhen: 'lower' },
  { key: 'cr_qm', label: 'CR(q→m)', format: v => `${v}%`, kind: 'ratio', goodWhen: 'higher' },
  { key: 'deals', label: 'Сделки', format: v => String(v), kind: 'count', goodWhen: 'higher' },
  { key: 'cac', label: 'CAC', format: formatMoney, kind: 'rate', goodWhen: 'lower' },
  { key: 'cr_lo', label: 'CR(l→o)', format: v => `${v}%`, kind: 'ratio', goodWhen: 'higher' },
  { key: 'revenue', label: 'Revenue', format: formatMoney, kind: 'count', goodWhen: 'higher' },
  { key: 'aov', label: 'AOV', format: formatMoney, kind: 'rate', goodWhen: 'higher' },
]

// Ячейка строки отклонения — единая логика для всех трёх видов метрик.
function DeviationCell({ m, fact, plan }) {
  if (fact == null || plan == null) return <td className="td-muted">—</td>
  if (m.kind === 'count') {
    if (!plan) return <td className="td-muted">—</td>
    const pct = Math.round((fact / plan) * 100)
    const good = m.goodWhen === 'lower' ? fact <= plan : fact >= plan
    return <td style={{ fontWeight: 700, color: good ? 'var(--green-primary)' : 'var(--red)' }}>{pct}%</td>
  }
  if (m.kind === 'rate') {
    const diff = fact - plan
    const good = m.goodWhen === 'lower' ? diff <= 0 : diff >= 0
    return (
      <td style={{ fontWeight: 700, color: good ? 'var(--green-primary)' : 'var(--red)' }}>
        {diff <= 0 ? '<' : '>'} на {formatMoney(Math.abs(diff))}
      </td>
    )
  }
  // ratio — разница в процентных пунктах
  const diff = Math.round((fact - plan) * 10) / 10
  const good = m.goodWhen === 'lower' ? diff <= 0 : diff >= 0
  return (
    <td style={{ fontWeight: 700, color: good ? 'var(--green-primary)' : 'var(--red)' }}>
      {diff > 0 ? '+' : ''}{diff}%
    </td>
  )
}

export default function RegularManagementPage() {
  const [loading, setLoading] = useState(true)
  const [weekCols, setWeekCols] = useState([])

  useEffect(() => {
    async function load() {
      setLoading(true)
      const [{ data: stats }, { data: historical }, { data: targets }] = await Promise.all([
        supabase.from('weekly_stats').select('week_start, leads, quals, meetings, deals, spend, revenue'),
        supabase.from('dashboard_historical_weeks').select('*'),
        supabase.from('monthly_targets').select('*'),
      ])

      // Компания целиком — суммируем по всем подрядчикам, contractor_id не важен.
      const byWeek = {}
      for (const r of stats || []) {
        if (!r.week_start) continue
        if (!byWeek[r.week_start]) byWeek[r.week_start] = { leads: 0, quals: 0, meetings: 0, deals: 0, spend: 0, revenue: 0 }
        const a = byWeek[r.week_start]
        a.leads += r.leads || 0
        a.quals += r.quals || 0
        a.meetings += r.meetings || 0
        a.deals += r.deals || 0
        a.spend += Number(r.spend) || 0
        a.revenue += Number(r.revenue) || 0
      }
      // Историческая сводка ПЕРЕЗАПИСЫВАЕТ live за ту же неделю (см. Дашборд).
      for (const h of historical || []) {
        byWeek[h.week_start] = {
          leads: h.leads || 0, quals: h.quals || 0, meetings: h.meetings || 0,
          deals: h.deals || 0, spend: Number(h.spend) || 0, revenue: Number(h.revenue) || 0,
        }
      }

      const targetsByMonth = {}
      for (const t of targets || []) targetsByMonth[t.month] = t

      const weeks = Object.keys(byWeek).sort()
      const cols = weeks.map(week_start => {
        const fact = { ...byWeek[week_start], ...deriveRates(byWeek[week_start]) }
        const t = targetsByMonth[monthKeyOf(week_start)]
        const paceRatio = periodPaceRatio('week', week_start)
        const planRaw = {
          spend: t?.plan_spend != null ? t.plan_spend * WEEK_RATIO * paceRatio : null,
          leads: t?.plan_leads != null ? t.plan_leads * WEEK_RATIO * paceRatio : null,
          quals: t?.plan_quals != null ? t.plan_quals * WEEK_RATIO * paceRatio : null,
          meetings: t?.plan_meetings != null ? t.plan_meetings * WEEK_RATIO * paceRatio : null,
          deals: t?.plan_deals != null ? t.plan_deals * WEEK_RATIO * paceRatio : null,
          revenue: t?.plan_revenue != null ? t.plan_revenue * WEEK_RATIO * paceRatio : null,
        }
        const planCounts = {
          spend: planRaw.spend != null ? Math.round(planRaw.spend) : null,
          leads: planRaw.leads != null ? Math.round(planRaw.leads) : null,
          quals: planRaw.quals != null ? Math.round(planRaw.quals) : null,
          meetings: planRaw.meetings != null ? Math.round(planRaw.meetings) : null,
          deals: planRaw.deals != null ? Math.round(planRaw.deals) : null,
          revenue: planRaw.revenue != null ? Math.round(planRaw.revenue) : null,
        }
        const planRates = {
          cpl: planRaw.leads > 0 ? Math.round(planRaw.spend / planRaw.leads) : null,
          cpql: planRaw.quals > 0 ? Math.round(planRaw.spend / planRaw.quals) : null,
          cpm: planRaw.meetings > 0 ? Math.round(planRaw.spend / planRaw.meetings) : null,
          cac: planRaw.deals > 0 ? Math.round(planRaw.spend / planRaw.deals) : null,
          cr_lq: planRaw.leads > 0 ? Math.round((planRaw.quals / planRaw.leads) * 1000) / 10 : null,
          cr_qm: planRaw.quals > 0 ? Math.round((planRaw.meetings / planRaw.quals) * 1000) / 10 : null,
          cr_lo: planRaw.leads > 0 ? Math.round((planRaw.deals / planRaw.leads) * 1000) / 10 : null,
          aov: planRaw.deals > 0 ? Math.round(planRaw.revenue / planRaw.deals) : null,
        }
        return { week_start, fact, plan: { ...planCounts, ...planRates } }
      })
      setWeekCols(cols)
      setLoading(false)
    }
    load()
  }, [])

  if (loading) return <div className="loading">Загрузка...</div>

  return (
    <div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
        Компания целиком, по неделям — план и факт по всем метрикам рядом. Крайний левый столбец и шапка
        закреплены, недели листаются скроллом вправо.
      </div>
      {weekCols.length === 0 ? (
        <div className="empty-state"><div className="empty-state-icon">📅</div><h3>Нет данных</h3></div>
      ) : (
        <div className="regmgmt-wrap">
          <table className="regmgmt-table">
            <thead>
              <tr>
                <th className="regmgmt-label-col">Рабочая неделя</th>
                {weekCols.map(c => (
                  <th key={c.week_start}>{getISOWeek(c.week_start)}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {METRIC_GROUPS.map(m => (
                <React.Fragment key={m.key}>
                  <tr>
                    <td className="regmgmt-label-col" style={{ fontWeight: 700 }}>
                      {m.label}
                      <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11 }}>
                        {' '}{m.kind === 'count' ? '% выполнения' : 'отклонение'}
                      </span>
                    </td>
                    {weekCols.map(c => (
                      <DeviationCell key={c.week_start} m={m} fact={c.fact[m.key]} plan={c.plan[m.key]} />
                    ))}
                  </tr>
                  <tr>
                    <td className="regmgmt-label-col td-muted">План</td>
                    {weekCols.map(c => (
                      <td key={c.week_start} className="td-muted">{c.plan[m.key] != null ? m.format(c.plan[m.key]) : '—'}</td>
                    ))}
                  </tr>
                  <tr className="regmgmt-group-end">
                    <td className="regmgmt-label-col" style={{ fontWeight: 600 }}>Факт</td>
                    {weekCols.map(c => (
                      <td key={c.week_start} style={{ fontWeight: 600 }}>{c.fact[m.key] != null ? m.format(c.fact[m.key]) : '—'}</td>
                    ))}
                  </tr>
                </React.Fragment>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
