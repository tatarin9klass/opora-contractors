import React, { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatMoney, formatDate } from '../lib/helpers.js'
import { todayISO, weekStartOf, addDaysISO } from '../lib/dateContext.js'

// ТЗ раздел 8: Фикс и Абонентка — полностью авто, без поля ввода. Абонентка +
// бюджет — частично вручную (бюджет за неделю) + авто-доля абонентки.
// Бесплатный трафик — расход всегда 0, поле ввода не нужно вообще.
const PARTIAL = 'Абонентка + бюджет'

function weekOptions() {
  const currentWeekThu = weekStartOf(todayISO())
  const weeks = []
  for (let i = 1; i <= 10; i++) {
    weeks.push(addDaysISO(currentWeekThu, -7 * i))
  }
  return weeks
}

export default function WeeklyExpensesPage() {
  const weeks = useMemo(weekOptions, [])
  const [selectedWeek, setSelectedWeek] = useState(weeks[0])
  const [enteredBy, setEnteredBy] = useState('')
  const [contractors, setContractors] = useState([])
  const [sources, setSources] = useState([])
  const [leadsBySource, setLeadsBySource] = useState({})
  const [existingBySource, setExistingBySource] = useState({})
  const [manualInputs, setManualInputs] = useState({})
  const [frozenWeeks, setFrozenWeeks] = useState(new Set())
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [savedAt, setSavedAt] = useState(null)

  // ТЗ раздел 3/9: замороженную неделю редактировать нельзя — исключаем её
  // из выбора и, если по умолчанию выбранная неделя оказалась заморожена,
  // переключаемся на ближайшую незамороженную.
  useEffect(() => {
    supabase.from('weekly_snapshots').select('week_start').then(({ data }) => {
      const set = new Set((data || []).map(r => r.week_start))
      setFrozenWeeks(set)
      if (set.has(selectedWeek)) {
        const firstOpen = weeks.find(w => !set.has(w))
        if (firstOpen) setSelectedWeek(firstOpen)
      }
    })
  }, [])

  const selectableWeeks = weeks.filter(w => !frozenWeeks.has(w))

  async function load() {
    setLoading(true)
    const weekEnd = addDaysISO(selectedWeek, 6)
    const [contractorsRes, sourcesRes, factsRes, expensesRes] = await Promise.all([
      supabase.from('contractor_mtd').select('*'),
      supabase.from('sources').select('*, payment_types(name)').eq('status', 'активен').order('created_at'),
      supabase.from('daily_facts').select('source_id, leads').gte('fact_date', selectedWeek).lte('fact_date', weekEnd),
      supabase.from('weekly_expenses').select('*').eq('week_start', selectedWeek),
    ])

    setContractors((contractorsRes.data || []).filter(c => c.is_active))
    setSources(sourcesRes.data || [])

    const leadsMap = {}
    ;(factsRes.data || []).forEach(f => {
      if (!f.source_id) return
      leadsMap[f.source_id] = (leadsMap[f.source_id] || 0) + (f.leads || 0)
    })
    setLeadsBySource(leadsMap)

    const expMap = {}
    ;(expensesRes.data || []).forEach(e => { expMap[e.source_id] = e })
    setExistingBySource(expMap)

    setLoading(false)
  }

  useEffect(() => { load() }, [selectedWeek])

  // Строки к отображению: ВСЕ активные источники подрядчика, каждый своей
  // строкой — единственный способ объединить несколько источников в одну
  // строку теперь явный (expense_group_id, задаётся в паспорте), а не
  // угадывается по совпадению модели оплаты. Раньше при одинаковой модели
  // оплаты у всех источников список молча схлопывался до первого источника —
  // это тихо теряло остальные источники подрядчика (в т.ч. те, что специально
  // оставили не объединёнными), поэтому убрано.
  // Источник (или группа) без модели оплаты и без лидов за неделю не
  // показываем — вводить по нему нечего. Если модель задана — показываем
  // всегда, даже без лидов за неделю (Абонентка платится независимо от лидов).
  const rows = useMemo(() => {
    const out = []
    for (const c of contractors) {
      const contractorSources = sources.filter(s => s.contractor_id === c.contractor_id)
      if (contractorSources.length === 0) continue

      const groupsSeen = new Set()
      let items = []
      for (const s of contractorSources) {
        if (s.expense_group_id) {
          if (groupsSeen.has(s.expense_group_id)) continue
          groupsSeen.add(s.expense_group_id)
          const members = contractorSources.filter(m => m.expense_group_id === s.expense_group_id)
          // Защита: группа валидна только если у всех участников до сих пор
          // одинаковый payment_type_id (могли поменять после объединения) —
          // иначе показываем их как отдельные строки, не смешивая формулы.
          const typesMatch = new Set(members.map(m => m.payment_type_id)).size === 1
          if (typesMatch && members.length > 1) {
            items.push({ isGroup: true, members })
          } else {
            members.forEach(m => items.push({ isGroup: false, members: [m] }))
          }
        } else {
          items.push({ isGroup: false, members: [s] })
        }
      }

      items = items.filter(item => {
        if (item.members.some(m => m.payment_types?.name)) return true
        const leads = item.members.reduce((sum, m) => sum + (leadsBySource[m.id] || 0), 0)
        return leads > 0
      })

      items.forEach(item => out.push({ contractor: c, ...item }))
    }
    return out
  }, [contractors, sources, leadsBySource])

  function computeRow(row) {
    const members = row.members
    const primary = members[0]
    const paymentName = primary.payment_types?.name
    const leads = members.reduce((s, m) => s + (leadsBySource[m.id] || 0), 0)
    const retainerWeekly = members.reduce((s, m) => s + (m.retainer ? (m.retainer / 30.41) * 7 : 0), 0)
    // Итог по группе всегда пишется в weekly_expenses ЗА ПЕРВЫЙ источник группы (см. saveAll) —
    // поэтому существующее значение подтягиваем именно оттуда.
    const existing = existingBySource[primary.id]

    if (paymentName === 'Фикс') {
      // Ставка CPL может отличаться у источников внутри группы — считаем
      // каждый своей ставкой и суммируем, а не берём одну общую ставку.
      const total = Math.round(members.reduce((s, m) => s + (m.cpl_rate || 0) * (leadsBySource[m.id] || 0), 0))
      return { mode: 'auto', total, detail: `${leads} лид.` }
    }
    if (paymentName === 'Абонентка') {
      const total = Math.round(retainerWeekly)
      return { mode: 'auto', total, detail: 'абонентка / нед.' }
    }
    if (paymentName === 'Бесплатный трафик') {
      return { mode: 'auto', total: 0, detail: 'бесплатный трафик — расход не вводится' }
    }
    if (paymentName === PARTIAL) {
      const autoPortion = Math.round(retainerWeekly)
      const manualDefault = existing ? Math.max(0, Math.round(existing.spend - autoPortion)) : ''
      return { mode: 'partial', autoPortion, manualDefault, detail: `+ абонентка ${formatMoney(autoPortion)} / нед.` }
    }
    // Модель не задана или устаревшая (CPL/Процент/Смешанная, ТЗ раздел 8.1) — просто ручной ввод
    return { mode: 'manual', manualDefault: existing ? existing.spend : '', detail: paymentName ? `модель «${paymentName}» — ручной ввод` : 'модель оплаты не задана' }
  }

  function inputValue(row) {
    const key = row.members[0].id
    if (manualInputs[key] !== undefined) return manualInputs[key]
    const r = computeRow(row)
    return r.manualDefault ?? ''
  }

  function rowTotal(row) {
    const r = computeRow(row)
    if (r.mode === 'auto') return r.total
    const manual = Number(inputValue(row) || 0)
    return r.mode === 'partial' ? manual + r.autoPortion : manual
  }

  const totalSum = rows.reduce((s, row) => s + rowTotal(row), 0)

  // Группировка по подрядчику — если у подрядчика несколько строк (разные
  // источники), показываем подзаголовок с названием подрядчика один раз,
  // а строки под ним — по источникам.
  const groupedRows = useMemo(() => {
    const groups = []
    const byContractor = new Map()
    for (const row of rows) {
      const key = row.contractor.contractor_id
      if (!byContractor.has(key)) {
        const group = { contractor: row.contractor, items: [] }
        byContractor.set(key, group)
        groups.push(group)
      }
      byContractor.get(key).items.push(row)
    }
    return groups
  }, [rows])

  async function saveAll() {
    if (!enteredBy) { alert('Укажи, кто вносит расход'); return }
    setSaving(true)
    for (const row of rows) {
      const r = computeRow(row)
      const spend = rowTotal(row)
      const isAuto = r.mode === 'auto'
      const primary = row.members[0]
      const existing = existingBySource[primary.id]
      const payload = {
        source_id: primary.id,
        contractor_id: row.contractor.contractor_id,
        week_start: selectedWeek,
        spend,
        is_auto_calculated: isAuto,
        entered_by: enteredBy,
        updated_at: new Date().toISOString(),
      }
      if (existing) {
        await supabase.from('weekly_expenses').update(payload).eq('id', existing.id)
      } else {
        await supabase.from('weekly_expenses').insert(payload)
      }
      // Остальные источники группы — 0, чтобы не оставалось "хвостов" от
      // периода до объединения (иначе сумма по подрядчику задвоится).
      for (const other of row.members.slice(1)) {
        const otherExisting = existingBySource[other.id]
        const zeroPayload = {
          source_id: other.id,
          contractor_id: row.contractor.contractor_id,
          week_start: selectedWeek,
          spend: 0,
          is_auto_calculated: true,
          entered_by: enteredBy,
          updated_at: new Date().toISOString(),
        }
        if (otherExisting) {
          await supabase.from('weekly_expenses').update(zeroPayload).eq('id', otherExisting.id)
        } else {
          await supabase.from('weekly_expenses').insert(zeroPayload)
        }
      }
    }
    setSaving(false)
    setSavedAt(new Date())
    setManualInputs({})
    load()
  }

  if (loading) return <div className="loading">Загрузка...</div>

  return (
    <div>
      <div className="info-card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
          <div className="info-card-title" style={{ margin: 0 }}>Расход за неделю</div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>Итого за неделю</div>
            <div style={{ fontSize: 24, fontWeight: 700 }}>{formatMoney(totalSum)}</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', marginTop: 8 }}>
          <select className="form-select" style={{ maxWidth: 260 }} value={selectedWeek} onChange={e => { setSelectedWeek(e.target.value); setManualInputs({}) }}>
            {selectableWeeks.map(w => <option key={w} value={w}>{formatDate(w)} — {formatDate(addDaysISO(w, 6))}</option>)}
          </select>
          <input className="form-input" style={{ maxWidth: 220 }} value={enteredBy} onChange={e => setEnteredBy(e.target.value)} placeholder="Кто вносит расход" />
          <button className="btn btn-primary" onClick={saveAll} disabled={saving}>
            {saving ? 'Сохранение...' : '✓ Сохранить все расходы за неделю'}
          </button>
          {savedAt && <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>Сохранено {savedAt.toLocaleTimeString('ru-RU')}</span>}
        </div>
        <div className="form-hint" style={{ marginTop: 8 }}>
          Фикс и Абонентка считаются автоматически — поле недоступно для редактирования. Для «Абонентка + бюджет» нужно ввести только рекламный бюджет за неделю, доля абонентки прибавится сама.
        </div>
      </div>

      <div className="table-wrap">
        {rows.length === 0 ? (
          <div className="empty-state"><div className="empty-state-icon">💸</div><h3>Нет активных подрядчиков с источниками</h3></div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Подрядчик / источник</th>
                <th>Модель</th>
                <th style={{ textAlign: 'right' }}>Сумма</th>
                <th>Комментарий</th>
              </tr>
            </thead>
            <tbody>
              {groupedRows.map(group => {
                const grouped = group.items.length > 1
                return (
                  <React.Fragment key={group.contractor.contractor_id}>
                    {grouped && (
                      <tr>
                        <td colSpan={4} style={{ padding: '10px 6px 4px', fontWeight: 700, fontSize: 13, borderBottom: 'none' }}>
                          {group.contractor.short_name || group.contractor.name}
                          <span style={{ fontWeight: 400, color: 'var(--text-muted)', fontSize: 11, marginLeft: 8 }}>разные источники / модели оплаты</span>
                        </td>
                      </tr>
                    )}
                    {group.items.map(row => {
                      const r = computeRow(row)
                      const primary = row.members[0]
                      const label = row.isGroup
                        ? row.members.map(m => m.name).join(' + ')
                        : (grouped ? primary.name : (row.contractor.short_name || row.contractor.name))
                      return (
                        <tr key={primary.id}>
                          <td style={{ fontWeight: grouped ? 400 : 500, paddingLeft: grouped ? 22 : undefined }}>
                            {label}
                            {row.isGroup && <span className="badge badge-control" style={{ marginLeft: 6, fontSize: 10 }}>объединено</span>}
                          </td>
                          <td className="td-muted">{primary.payment_types?.name || '—'}</td>
                          <td style={{ textAlign: 'right' }}>
                            {r.mode === 'auto' ? (
                              <span style={{ fontWeight: 600 }}>{formatMoney(r.total)}</span>
                            ) : r.mode === 'partial' ? (
                              <div style={{ display: 'flex', alignItems: 'center', gap: 6, justifyContent: 'flex-end' }}>
                                <input
                                  className="form-input"
                                  type="number"
                                  style={{ width: 110, textAlign: 'right' }}
                                  value={inputValue(row)}
                                  onChange={e => setManualInputs(m => ({ ...m, [primary.id]: e.target.value }))}
                                  placeholder="0"
                                />
                                <span style={{ fontWeight: 600 }}>= {formatMoney(rowTotal(row))}</span>
                              </div>
                            ) : (
                              <input
                                className="form-input"
                                type="number"
                                style={{ width: 110, textAlign: 'right', marginLeft: 'auto', display: 'block' }}
                                value={inputValue(row)}
                                onChange={e => setManualInputs(m => ({ ...m, [primary.id]: e.target.value }))}
                                placeholder="0"
                              />
                            )}
                          </td>
                          <td className="td-muted" style={{ fontSize: 11 }}>{r.detail}</td>
                        </tr>
                      )
                    })}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        )}
      </div>
    </div>
  )
}
