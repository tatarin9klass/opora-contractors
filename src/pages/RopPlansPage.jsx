import React, { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { todayISO } from '../lib/dateContext.js'
import { recentMonths, PLAN_METRICS } from '../lib/rop.js'

// ============================================================================
// Планы отдела продаж на месяц.
//
// ПЛАН СТАВИТСЯ РУКОВОДИТЕЛЕМ НАПРАВЛЕНИЯ, А НЕ РОПом. Поэтому экран живёт у
// админа: РОП свои планы видит, но не правит. Так же устроены цели
// подрядчиков, и причина та же — план, который можно переписать задним
// числом, перестаёт быть планом.
//
// СТРОКА «ОТДЕЛ» — ЭТО НЕ СУММА СТРОК МЕНЕДЖЕРОВ. Она хранится отдельно
// (manager_name = NULL) и может быть больше суммы: руководитель закладывает
// запас. Складывать за него мы не вправе, поэтому и не складываем — но
// подсказываем сумму рядом, чтобы расхождение было видно сразу.
//
// ПУСТАЯ КЛЕТКА — ЭТО ОТСУТСТВИЕ ПЛАНА, А НЕ НОЛЬ. На дашборде по такой
// метрике не будет ни плана, ни оценки «не выполнено». Ноль означал бы, что
// план поставлен и равен нулю, то есть выполнен всегда.
// ============================================================================

const ОТДЕЛ = '__отдел__'

function cellKey(manager, metric) {
  return `${manager || ОТДЕЛ}|${metric}`
}

// В форме живут строки, а не числа: пустая строка должна отличаться от нуля,
// а пользователь по дороге набирает «1», «12», «12 » — приводить к числу
// можно только на сохранении.
function toValue(raw) {
  const s = String(raw ?? '').replace(/\s/g, '').replace(',', '.')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

export default function RopPlansPage() {
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
    setLoading(true); setError(''); setNote('')
    try {
      const [{ data: mg, error: e1 }, { data: pl, error: e2 }] = await Promise.all([
        supabase.from('rop_managers').select('manager_name, sort_order')
          .eq('active', true).order('sort_order'),
        supabase.from('rop_plans').select('id, period, manager_name, metric, value')
          .eq('period', p),
      ])
      if (e1) throw e1
      if (e2) throw e2
      setManagers(mg || [])
      const map = {}
      const f = {}
      for (const row of pl || []) {
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

  useEffect(() => { load(period) }, [period])

  const rows = useMemo(() => [
    { key: ОТДЕЛ, name: null, label: 'Отдел целиком' },
    ...managers.map(m => ({ key: m.manager_name, name: m.manager_name, label: m.manager_name })),
  ], [managers])

  // Что изменилось. Считается на каждый рендер и стоит копейки: клеток
  // меньше полусотни.
  const changes = useMemo(() => {
    const out = []
    for (const r of rows) {
      for (const met of PLAN_METRICS) {
        const k = cellKey(r.name, met.id)
        const was = saved[k]
        const now = toValue(form[k])
        if (was && now == null) out.push({ op: 'delete', id: was.id, k })
        else if (was && now !== was.value) out.push({ op: 'update', id: was.id, value: now, k })
        else if (!was && now != null) out.push({ op: 'insert', manager_name: r.name, metric: met.id, value: now, k })
      }
    }
    return out
  }, [rows, saved, form])

  async function save() {
    if (!changes.length) return
    setSaving(true); setError(''); setNote('')
    try {
      const ins = changes.filter(c => c.op === 'insert')
        .map(c => ({ period, manager_name: c.manager_name, metric: c.metric, value: c.value }))
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

  // Сумма по менеджерам — только подсказка. Штука, по которой видно, что
  // план отдела разложен не полностью.
  function managersSum(metric) {
    let s = 0, n = 0
    for (const r of rows) {
      if (!r.name) continue
      const v = toValue(form[cellKey(r.name, metric)])
      if (v != null) { s += v; n += 1 }
    }
    return n ? s : null
  }

  const label = options.find(o => o.start === period)?.label || period

  return (
    <div>
      <div className="portal-section-head">
        <h2 className="portal-section-title">Планы на месяц</h2>
        <p className="portal-section-note">
          Пустая клетка — плана нет: на дашборде по такой метрике не будет ни
          плана, ни оценки. «Брак» задаётся нормой в процентах и читается как
          «не выше», остальные метрики — как «не ниже».
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
          <button className="btn btn-primary btn-sm" disabled={!changes.length || saving} onClick={save}>
            {saving ? 'Сохраняю...' : changes.length ? `Сохранить (${changes.length})` : 'Нет изменений'}
          </button>
        </div>
      </div>

      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

      {loading ? <div className="loading">Загрузка...</div> : (
        <div className="table-wrap">
          <div className="table-scroll">
            <table className="table-compact rop-table rop-plans">
              <thead>
                <tr>
                  <th style={{ minWidth: 170 }}>Кому</th>
                  {PLAN_METRICS.map(m => (
                    <th key={m.id} className="portal-num">
                      {m.label}
                      {m.unit !== 'шт' && <span className="rop-unit"> {m.unit}</span>}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {rows.map(r => (
                  <tr key={r.key} className={r.name ? '' : 'rop-row-total'}>
                    <td style={{ fontWeight: r.name ? 500 : 700, whiteSpace: 'nowrap' }}>{r.label}</td>
                    {PLAN_METRICS.map(m => {
                      const k = cellKey(r.name, m.id)
                      const dirty = changes.some(c => c.k === k)
                      return (
                        <td key={m.id} className="portal-num">
                          <input
                            className={`form-input rop-plan-input ${dirty ? 'dirty' : ''}`}
                            inputMode="decimal"
                            value={form[k] ?? ''}
                            placeholder="—"
                            onChange={e => setForm(f => ({ ...f, [k]: e.target.value }))}
                          />
                        </td>
                      )
                    })}
                  </tr>
                ))}
                <tr className="rop-subrow">
                  <td style={{ color: 'var(--text-muted)' }}>сумма по менеджерам</td>
                  {PLAN_METRICS.map(m => {
                    // Средний чек и норму брака складывать бессмысленно: это
                    // не объёмы. Складывать их значило бы печатать число,
                    // которое ничего не означает.
                    const additive = m.unit === 'шт'
                    const s = additive ? managersSum(m.id) : null
                    const dept = toValue(form[cellKey(null, m.id)])
                    const gap = additive && s != null && dept != null && s !== dept
                    return (
                      <td key={m.id} className="portal-num">
                        {s == null ? <span className="td-muted">—</span> : (
                          <span className={gap ? 'rop-gap' : ''}>
                            {s}{gap ? ` (у отдела ${dept})` : ''}
                          </span>
                        )}
                      </td>
                    )
                  })}
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      <div className="rop-footer">
        План отдела хранится отдельно от планов менеджеров и не обязан быть их
        суммой — расхождение в последней строке показано как подсказка, а не
        как ошибка. Состав отдела берётся из таблицы rop_managers: ушёл
        человек — снимите отметку «активен», и его прошлые результаты
        останутся в истории, а в текущих показателях он больше не появится.
      </div>
    </div>
  )
}
