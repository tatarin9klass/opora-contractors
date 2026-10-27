import React, { useEffect, useMemo, useState } from 'react'
import { todayISO } from '../lib/dateContext.js'
import {
  loadRopData, periodBounds, recentMonths, planFor, planStatus, paceTarget,
  runRate, quotaPerDay, byTeam,
} from '../lib/rop.js'
import { formatNum, plural } from '../lib/helpers.js'

// ============================================================================
// Менеджеры отдела: тот же разговор, что на «Главном», но по людям.
//
// КОЛОНКИ ПОВТОРЯЮТ ПЛИТКИ ГЛАВНОГО ЭКРАНА, и это главное решение. Раньше
// здесь жили одиннадцать показателей с конверсиями между этапами — таблица,
// по которой можно изучать отдел, но нельзя провести планёрку. План стоит на
// одном числе, значит и спрашивать надо по одному числу: сколько договоров
// БФЛ, при каком плане, какой темп и сколько надо делать дальше.
//
// КВОТА У КАЖДОГО СВОЯ, и она — главное, ради чего таблица существует.
// Отставание отдела само по себе не действие; отставание конкретного
// человека на столько-то договоров в день — действие.
//
// Итоговая строка складывает факт по людям, а план берёт тем же способом,
// что и «Главное»: как сумму планов менеджеров. Поэтому строка «Отдел» и
// плитка на первом экране не могут разойтись.
// ============================================================================

const MODES = [
  { id: 'month', label: 'Месяц' },
  { id: 'week', label: 'Неделя' },
  { id: 'range', label: 'Период' },
]

const KEYS = ['окс_бфл', 'окс_аз', 'окс_вки']

function blank() {
  const o = {}
  for (const k of KEYS) o[k] = 0
  return o
}

function add(t, r) {
  for (const k of KEYS) t[k] += Number(r[k] || 0)
}

// Квота печатается через запятую и только до десятых: «1,5 договора в день»
// понятно, «1,4838709677» — нет.
function Quota({ q }) {
  if (q == null) return <span className="td-muted">плана нет</span>
  if (q.дней === 0) return <span className="td-muted">период закрыт</span>
  if (q.осталось === 0) return <span className="rop-conv ok">выполнен</span>
  return <span>{formatNum(q.квота)}</span>
}

export default function RopManagersPage({ team = null }) {
  const [mode, setMode] = useState('month')
  const [anchor, setAnchor] = useState(todayISO())
  const [from, setFrom] = useState(todayISO())
  const [to, setTo] = useState(todayISO())
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const months = useMemo(() => recentMonths(12), [])
  const bounds = useMemo(() => periodBounds(mode, anchor, from, to), [mode, anchor, from, to])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError('')
    loadRopData(bounds.from, bounds.to)
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(String(e?.message || e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [bounds.from, bounds.to])

  const plans = data?.plans || []

  const { люди, отдел } = useMemo(() => {
    const by = new Map()
    const сумма = blank()
    for (const r of byTeam(data?.byManager || [], team)) {
      if (!by.has(r.менеджер)) {
        by.set(r.менеджер, { менеджер: r.менеджер, работает: r.работает !== false, t: blank() })
      }
      add(by.get(r.менеджер).t, r)
      add(сумма, r)
    }
    // Человек без единого договора за период в таблице не нужен: строка из
    // прочерков ничего не говорит, а место занимает. Ушедшие показываются,
    // если результаты за период у них были, — их договоры принадлежат отделу.
    const list = [...by.values()]
      .filter(m => KEYS.some(k => m.t[k]))
      .sort((a, b) => b.t.окс_бфл - a.t.окс_бфл || a.менеджер.localeCompare(b.менеджер))
    return { люди: list, отдел: сумма }
  }, [data, team])

  const планОтдела = planFor(plans, bounds.from, 'оксвсего', null, team)
  const label = bounds.from.split('-').reverse().join('.') + ' — ' + bounds.to.split('-').reverse().join('.')

  if (loading && !data) return <div className="loading">Загрузка...</div>

  return (
    <div className={loading ? 'portal-fading' : ''}>
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="portal-period" style={{ marginBottom: 18 }}>
        <div className="portal-chips">
          {MODES.map(m => (
            <button key={m.id} className={`filter-chip ${mode === m.id ? 'active' : ''}`}
                    onClick={() => setMode(m.id)}>{m.label}</button>
          ))}
        </div>
        <div className="portal-period-detail">
          {mode === 'month' && (
            <select className="filter-select" value={anchor.slice(0, 8) + '01'}
                    onChange={e => setAnchor(e.target.value)}>
              {months.map(m => <option key={m.start} value={m.start}>{m.label}</option>)}
            </select>
          )}
          {mode === 'range' && (
            <>
              <input className="form-input portal-date" type="date" value={from}
                     min="2026-09-01" max={todayISO()} onChange={e => setFrom(e.target.value)} />
              <span className="portal-muted">—</span>
              <input className="form-input portal-date" type="date" value={to}
                     min="2026-09-01" max={todayISO()} onChange={e => setTo(e.target.value)} />
            </>
          )}
          <span className="portal-period-label">{label}</span>
        </div>
      </div>

      <div className="portal-section-head">
        <h2 className="portal-section-title">Менеджеры</h2>
        <p className="portal-section-note">
          План стоит только на договорах БФЛ — АЗ и ВКИ идут счётом, без
          оценки. Квота считается по каждому отдельно: это и есть то, что
          человеку говорят на планёрке.
        </p>
      </div>

      {люди.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📭</div>
          <h3>За этот период договоров нет</h3>
          <p>Сделки загружены с 1 сентября 2026 года.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <div className="table-scroll">
            <table className="table-compact rop-table">
              <thead>
                <tr>
                  <th style={{ minWidth: 180 }}>Менеджер</th>
                  <th className="portal-num">Договоры БФЛ</th>
                  <th className="portal-num">АЗ</th>
                  <th className="portal-num">ВКИ</th>
                  <th className="portal-num">Runrate</th>
                  <th className="portal-num">Квота на день</th>
                </tr>
              </thead>
              <tbody>
                {люди.map(m => {
                  const план = planFor(plans, bounds.from, 'оксвсего', m.менеджер, team)
                  const rr = runRate(m.t.окс_бфл, bounds.from, bounds.to)
                  const q = quotaPerDay(план, m.t.окс_бфл, bounds.to)
                  return (
                    <tr key={m.менеджер}>
                      <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {m.менеджер}
                        {!m.работает && <span className="rop-left"> уволен</span>}
                      </td>
                      <td className="portal-num">
                        {formatNum(m.t.окс_бфл)}
                        {план != null && (
                          <span className={`rop-plan ${planStatus(m.t.окс_бфл, paceTarget(план, bounds.from, bounds.to))}`}>
                            /{formatNum(план)}
                          </span>
                        )}
                      </td>
                      <td className="portal-num">{formatNum(m.t.окс_аз)}</td>
                      <td className="portal-num">{formatNum(m.t.окс_вки)}</td>
                      <td className="portal-num">{rr == null ? <span className="td-muted">—</span> : formatNum(rr)}</td>
                      <td className="portal-num"><Quota q={q} /></td>
                    </tr>
                  )
                })}
                <tr className="rop-row-total">
                  <td style={{ fontWeight: 700 }}>Отдел целиком</td>
                  <td className="portal-num">
                    {formatNum(отдел.окс_бфл)}
                    {планОтдела != null && (
                      <span className={`rop-plan ${planStatus(отдел.окс_бфл, paceTarget(планОтдела, bounds.from, bounds.to))}`}>
                        /{formatNum(планОтдела)}
                      </span>
                    )}
                  </td>
                  <td className="portal-num">{formatNum(отдел.окс_аз)}</td>
                  <td className="portal-num">{formatNum(отдел.окс_вки)}</td>
                  <td className="portal-num">
                    {formatNum(runRate(отдел.окс_бфл, bounds.from, bounds.to))}
                  </td>
                  <td className="portal-num">
                    <Quota q={quotaPerDay(планОтдела, отдел.окс_бфл, bounds.to)} />
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="rop-footer">
        Договор считается банкротным по депозиту арбитражного управляющего
        среди позиций, а не по названию услуги. АЗ и ВКИ продаются поверх
        договора, поэтому одна сделка может попасть и в БФЛ, и в АЗ —
        колонки намеренно не складываются в одну сумму. Runrate — сколько
        выйдет к концу периода, если дальше пойдёт как сейчас; для
        закрытого периода он равен факту. Квота — сколько договоров надо
        заключать каждый оставшийся день, считая сегодняшний: (план − факт)
        ÷ оставшиеся дни. План на отдел не задаётся отдельно, он равен сумме
        планов менеджеров{планОтдела != null && люди.length
          ? ` — сейчас это ${formatNum(планОтдела)} ${plural(планОтдела, 'договор', 'договора', 'договоров')}`
          : ''}.
      </div>
    </div>
  )
}
