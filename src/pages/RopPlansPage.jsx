import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { todayISO } from '../lib/dateContext.js'
import { recentMonths, PLAN_METRICS } from '../lib/rop.js'
import { parsePlanValue, formatContractMoney } from '../lib/ropMoney.js'
import { formatNum, plural } from '../lib/helpers.js'

// ============================================================================
// Планы отдела продаж на месяц.
//
// ПЛАН СТАВИТ РУКОВОДИТЕЛЬ ОТДЕЛА — сам, по своим людям. Право проверяется в
// базе, а не в интерфейсе: политика на rop_plans пускает РОПа к строкам
// менеджеров своего отдела и никуда больше (20261020_rop_plans_by_rop.sql).
//
// ПЛАН НА ОТДЕЛ НЕ ЗАДАЁТСЯ — ОН СКЛАДЫВАЕТСЯ. Раньше он хранился отдельной
// строкой и мог не совпадать с раскладкой по людям: руководитель закладывал
// запас. На практике расхождение только путало — на первом экране стояло
// одно число, в таблице менеджеров складывалось другое, и какое настоящее,
// было непонятно. Теперь настоящее одно: то, что разложено на людей.
//
// Планы по количеству БФЛ и полной сумме всех договоров задаются на месяц.
//
// ПУСТАЯ КЛЕТКА — ЭТО ОТСУТСТВИЕ ПЛАНА, А НЕ НОЛЬ. На первом экране по
// такому месяцу не будет ни плана, ни квоты, ни оценки. Ноль означал бы, что
// план поставлен и равен нулю, то есть выполнен всегда.
// ============================================================================

function cellKey(manager, metric) {
  return `${manager}|${metric}`
}

// В форме живут строки, а не числа: пустая строка должна отличаться от нуля,
// а пользователь по дороге набирает «1», «12», «12 » — приводить к числу
// можно только на сохранении.
function toValue(raw) {
  try { return parsePlanValue(raw) } catch { return null }
}

export default function RopPlansPage({ team = null }) {
  const months = useMemo(() => recentMonths(12), [])
  // Планы ставят на текущий месяц чаще всего, но следующий тоже нужен —
  // иначе первого числа план «появляется» задним числом.
  const options = useMemo(() => {
    const [y, m] = todayISO().split('-').map(Number)
    const ny = m === 12 ? y + 1 : y
    const nm = m === 12 ? 1 : m + 1
    const NAMES = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
      'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь']
    return [{ start: `${ny}-${String(nm).padStart(2, '0')}-01`, label: `${NAMES[nm - 1]} ${ny}` }, ...months]
  }, [months])

  const [period, setPeriod] = useState(() => todayISO().slice(0, 8) + '01')
  const [managers, setManagers] = useState([])
  const [saved, setSaved] = useState({})   // cellKey -> { id, value }
  const [form, setForm] = useState({})     // cellKey -> строка в поле
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [note, setNote] = useState('')

  async function load(p) {
    if (!team) return
    setLoading(true); setError(''); setNote('')
    try {
      // Состав и планы — строго одного отдела. Без фильтра по отделу в
      // таблицу попали бы чужие менеджеры.
      const [{ data: mg, error: e1 }, { data: pl, error: e2 }] = await Promise.all([
        supabase.from('rop_managers').select('manager_name, sort_order, active')
          .eq('team', team).order('sort_order'),
        supabase.from('rop_plans').select('id, period, manager_name, metric, value')
          .eq('period', p).eq('team', team),
      ])
      if (e1) throw e1
      if (e2) throw e2
      // Сохраняем в форме ушедших с планом на этот месяц, иначе общий план
      // на главной отличался бы от видимой суммы редактируемых строк.
      const planned = new Set((pl || []).filter(p => PLAN_METRICS.some(m => m.id === p.metric)).map(p => p.manager_name))
      setManagers((mg || []).filter(m => m.active || planned.has(m.manager_name)))
      const map = {}
      const f = {}
      for (const row of pl || []) {
        // Старые строки отдела (manager_name = NULL) больше не читаются и не
        // правятся: план отдела теперь складывается из планов менеджеров.
        if (!row.manager_name) continue
        const k = cellKey(row.manager_name, row.metric)
        map[k] = { id: row.id, value: Number(row.value) }
        f[k] = String(Number(row.value))
      }
      setSaved(map)
      setForm(f)
    } catch (e) {
      setError(String(e?.message || e))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => { load(period) }, [period, team])

  const invalid = useMemo(() => {
    const out = new Set()
    for (const m of managers) for (const metric of PLAN_METRICS) {
      const key = cellKey(m.manager_name, metric.id)
      try { parsePlanValue(form[key]) } catch { out.add(key) }
    }
    return out
  }, [managers, form])

  // Что изменилось. Считается на каждый рендер и стоит копейки: клеток
  // меньше десятка.
  const changes = useMemo(() => {
    const out = []
    for (const m of managers) {
      for (const met of PLAN_METRICS) {
        const k = cellKey(m.manager_name, met.id)
        if (invalid.has(k)) continue
        const was = saved[k]
        const now = toValue(form[k])
        if (was && now == null) out.push({ op: 'delete', id: was.id, k })
        else if (was && now !== was.value) out.push({ op: 'update', id: was.id, value: now, k })
        else if (!was && now != null) {
          out.push({ op: 'insert', manager_name: m.manager_name, metric: met.id, value: now, k })
        }
      }
    }
    return out
  }, [managers, saved, form, invalid])

  async function save() {
    if (!changes.length || invalid.size) return
    setSaving(true); setError(''); setNote('')
    try {
      const ins = changes.filter(c => c.op === 'insert')
        .map(c => ({ period, team, manager_name: c.manager_name, metric: c.metric, value: c.value }))
      const del = changes.filter(c => c.op === 'delete').map(c => c.id)

      if (del.length) {
        const { error } = await supabase.from('rop_plans').delete().in('id', del)
        if (error) throw error
      }
      for (const c of changes.filter(c => c.op === 'update')) {
        const { error } = await supabase.from('rop_plans')
          .update({ value: c.value, updated_at: new Date().toISOString() }).eq('id', c.id)
        if (error) throw error
      }
      if (ins.length) {
        const { error } = await supabase.from('rop_plans').insert(ins)
        if (error) throw error
      }
      await load(period)
      setNote(`Сохранено. Изменений: ${changes.length}.`)
    } catch (e) {
      setError(String(e?.message || e))
    } finally {
      setSaving(false)
    }
  }

  // Сумма по менеджерам и есть план отдела. Считается прямо из полей, а не
  // из сохранённого, — чтобы итог менялся, пока цифры набирают, и было
  // видно, к чему ведёт правка.
  function сумма(metric) {
    let s = 0, n = 0
    for (const m of managers) {
      const v = toValue(form[cellKey(m.manager_name, metric)])
      if (v != null) { s += v; n += 1 }
    }
    return n ? s : null
  }

  const label = options.find(o => o.start === period)?.label || period
  if (!team) return <div className="loading">Загрузка...</div>

  return (
    <div>
      <div className="portal-section-head">
        <h2 className="portal-section-title">Планы на месяц</h2>
        <p className="portal-section-note">
          Задайте месячные планы по количеству БФЛ и сумме всех договоров в рублях. План отдела
          отдельно не задаётся — он складывается из того, что вы разложили, и
          показан последней строкой. Пустая клетка означает, что плана нет: по
          такому месяцу не будет ни плана, ни квоты, ни оценки.
        </p>
      </div>

      <div className="portal-period" style={{ marginBottom: 16 }}>
        <div className="portal-period-detail" style={{ marginLeft: 0 }}>
          <select className="filter-select" value={period} onChange={e => setPeriod(e.target.value)}>
            {options.map(o => <option key={o.start} value={o.start}>{o.label}</option>)}
          </select>
          <span className="portal-period-label">планы на {label}</span>
        </div>
        <div className="portal-period-detail">
          {note && <span className="rop-saved">{note}</span>}
          <button className="btn btn-primary btn-sm" disabled={!changes.length || saving || invalid.size > 0 || loading} onClick={save}>
            {saving ? 'Сохраняю...' : changes.length ? `Сохранить (${changes.length})` : 'Нет изменений'}
          </button>
        </div>
      </div>

      {invalid.size > 0 && <div className="alert alert-danger" role="alert">План должен быть неотрицательным числом, не более двух знаков после запятой. Для удаления плана очистите поле.</div>}
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

      {loading ? <div className="loading">Загрузка...</div> : (
        <div className="table-wrap">
          <div className="table-scroll">
            <table className="table-compact rop-table rop-plans">
              <thead>
                <tr>
                  <th style={{ minWidth: 200 }}>Кому</th>
                  {PLAN_METRICS.map(m => (
                    <th key={m.id} className="portal-num">{m.label}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {managers.map(r => (
                  <tr key={r.manager_name}>
                    <td style={{ fontWeight: 500, whiteSpace: 'nowrap' }}>{r.manager_name}{!r.active && <span className="rop-left"> уволен</span>}</td>
                    {PLAN_METRICS.map(m => {
                      const k = cellKey(r.manager_name, m.id)
                      const dirty = changes.some(c => c.k === k)
                      return (
                        <td key={m.id} className="portal-num">
                          <input
                            className={`form-input rop-plan-input ${dirty ? 'dirty' : ''}`}
                            inputMode="decimal"
                            aria-label={`${r.manager_name}: ${m.label}`}
                            aria-invalid={invalid.has(k)}
                            disabled={saving}
                            value={form[k] ?? ''}
                            placeholder="—"
                            onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
                          />
                        </td>
                      )
                    })}
                  </tr>
                ))}
                <tr className="rop-row-total">
                  <td style={{ fontWeight: 700 }}>Отдел целиком</td>
                  {PLAN_METRICS.map(m => {
                    const s = сумма(m.id)
                    return (
                      <td key={m.id} className="portal-num" style={{ fontWeight: 700 }}>
                        {s == null ? <span className="td-muted">—</span> : m.unit === '₽' ? formatContractMoney(s) : formatNum(s)}
                      </td>
                    )
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {managers.length === 0 && !loading && (
        <div className="empty-state" style={{ marginTop: 16 }}>
          <div className="empty-state-icon">👥</div>
          <h3>В отделе нет активных менеджеров</h3>
          <p>Планы ставятся на людей, а ставить их не на кого.</p>
        </div>
      )}

      <div className="rop-footer">
        План отдела равен сумме планов менеджеров и отдельной цифрой не
        хранится: число, за которое никто персонально не отвечает, планом не
        является. Итог в последней строке пересчитывается прямо при наборе, до
        сохранения{(() => { const s = сумма('оксвсего'); return s == null ? '' : ` — сейчас ${formatNum(s)} ${plural(s, 'договор', 'договора', 'договоров')}` })()}.
        Состав отдела берётся из таблицы rop_managers: ушёл человек — снимите
        отметку «активен», и его прошлые результаты останутся в истории, а в
        планах он останется только за месяцы, где ему уже задан план.
      </div>
    </div>
  )
}
