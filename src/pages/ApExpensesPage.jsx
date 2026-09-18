import React, { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatMoney } from '../lib/helpers.js'
import { monthKeyOf, monthLabel } from '../lib/avtpravo.js'

// Расход в этом направлении вводится руками: месяц → канал → сумма.
// Автоматической интеграции (как Google Таблицы/Директ в БФЛ) здесь нет.

// Данные направления ведём с января 2026.
const FIRST_MONTH = '2026-01-01'

// Целочисленная арифметика по годам/месяцам, а не Date.setMonth: строка
// "2026-01-01" парсится как UTC-полночь, а setMonth/getMonth работают в
// локальной зоне — на этом стыке месяц уезжает на единицу.
function monthsRange(firstMonth) {
  const [fy, fm] = firstMonth.split('-').map(Number)
  const [ly, lm] = monthKeyOf().split('-').map(Number)
  const out = []
  for (let y = fy, m = fm; y < ly || (y === ly && m <= lm); m++) {
    if (m > 12) { m = 1; y++ }
    out.push(`${y}-${String(m).padStart(2, '0')}-01`)
  }
  return out.reverse()
}

export default function ApExpensesPage() {
  const [channels, setChannels] = useState([])
  const [expenses, setExpenses] = useState([])
  const [month, setMonth] = useState(monthKeyOf())
  const [draft, setDraft] = useState({})
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)
  const [loading, setLoading] = useState(true)

  async function load() {
    const [{ data: ch }, { data: ex }] = await Promise.all([
      supabase.from('ap_channels').select('*').order('sort_order'),
      supabase.from('ap_monthly_expenses').select('*'),
    ])
    setChannels(ch || [])
    setExpenses(ex || [])
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  // Черновик пересобирается при смене месяца — несохранённые правки по
  // прошлому месяцу при этом теряются намеренно, чтобы не записать их
  // случайно в другой месяц.
  useEffect(() => {
    const map = {}
    for (const e of expenses) {
      if (e.month === month) map[e.channel_id] = String(Number(e.spend || 0))
    }
    setDraft(map)
    setSavedAt(null)
  }, [month, expenses])

  const months = useMemo(() => monthsRange(FIRST_MONTH), [])

  const total = useMemo(
    () => channels.reduce((a, c) => a + (parseFloat(draft[c.id]) || 0), 0),
    [channels, draft],
  )

  async function save() {
    setSaving(true)
    const rows = channels.map(c => ({
      channel_id: c.id,
      month,
      spend: parseFloat(draft[c.id]) || 0,
      updated_at: new Date().toISOString(),
    }))
    const { error } = await supabase.from('ap_monthly_expenses').upsert(rows, { onConflict: 'channel_id,month' })
    setSaving(false)
    if (error) { alert('Ошибка сохранения: ' + error.message); return }
    setSavedAt(new Date())
    load()
  }

  if (loading) return <div className="loading">Загрузка...</div>

  return (
    <div className="info-card" style={{ maxWidth: 680 }}>
      <div className="info-card-title">Расход по каналам за месяц</div>
      <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
        Расход задаётся на канал целиком. Пустое поле сохраняется как 0.
      </div>

      <div style={{ marginBottom: 16, maxWidth: 260 }}>
        <select className="form-select" style={{ width: '100%' }} value={month} onChange={e => setMonth(e.target.value)}>
          {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
        </select>
      </div>

      <table className="table-compact">
        <thead>
          <tr>
            <th>Канал</th>
            <th style={{ textAlign: 'right', width: 180 }}>Расход, ₽</th>
          </tr>
        </thead>
        <tbody>
          {channels.map(c => (
            <tr key={c.id}>
              <td>{c.name}</td>
              <td style={{ textAlign: 'right' }}>
                <input
                  className="form-input"
                  type="number"
                  min="0"
                  step="1"
                  style={{ width: 160, textAlign: 'right' }}
                  value={draft[c.id] ?? ''}
                  onChange={e => setDraft(d => ({ ...d, [c.id]: e.target.value }))}
                />
              </td>
            </tr>
          ))}
          <tr className="totals-row" style={{ background: 'var(--green-bg)' }}>
            <td style={{ fontWeight: 700 }}>Итого</td>
            <td style={{ textAlign: 'right', fontWeight: 700 }}>{formatMoney(total)}</td>
          </tr>
        </tbody>
      </table>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginTop: 16 }}>
        <button className="btn btn-primary" onClick={save} disabled={saving}>
          {saving ? 'Сохраняем...' : '💾 Сохранить'}
        </button>
        {savedAt && <span style={{ fontSize: 12, color: 'var(--green-primary)' }}>Сохранено</span>}
      </div>
    </div>
  )
}
