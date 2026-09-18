import React, { useState, useEffect, useMemo } from 'react'
import { formatMoney, formatNum } from '../lib/helpers.js'
import { loadAvtpData, availableMonths, aggregateChannels, monthKeyOf, monthLabel, cpo } from '../lib/avtpravo.js'

const GROUPS = [
  { id: 'avtpr', label: 'АВТОПРАВО' },
  { id: 'avrkm', label: 'АВАРКОМ' },
]

const COLUMNS = [
  { key: 'name', label: 'Канал', align: 'left' },
  { key: 'spend', label: 'Расход', align: 'right' },
  { key: 'leads', label: 'Лиды', align: 'right' },
  { key: 'contracts', label: 'Договоры', align: 'right' },
  { key: 'cpo', label: 'CPO', align: 'right' },
]

function sumRows(rows) {
  const spend = rows.reduce((a, r) => a + r.spend, 0)
  const leads = rows.reduce((a, r) => a + r.leads, 0)
  const contracts = rows.reduce((a, r) => a + r.contracts, 0)
  return { spend, leads, contracts, cpo: cpo(spend, contracts) }
}

export default function ChannelsPage({ onOpenChannel }) {
  const [data, setData] = useState(null)
  const [month, setMonth] = useState(monthKeyOf())
  const [loading, setLoading] = useState(true)
  const [sortKey, setSortKey] = useState(null)
  const [sortDir, setSortDir] = useState('desc')

  useEffect(() => {
    loadAvtpData().then(d => {
      setData(d)
      // Текущий месяц обычно ещё не набрал данных в начале месяца — но если
      // его вообще нет в списке (импорт не доходил), встаём на самый свежий.
      const months = availableMonths(d)
      if (months.length && !months.includes(monthKeyOf())) setMonth(months[0])
      setLoading(false)
    })
  }, [])

  const months = useMemo(() => {
    if (!data) return []
    const list = availableMonths(data)
    const cur = monthKeyOf()
    return list.includes(cur) ? list : [cur, ...list]
  }, [data])

  const rows = useMemo(() => (data ? aggregateChannels(data, month) : []), [data, month])

  function toggleSort(key) {
    if (key === sortKey) setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    else { setSortKey(key); setSortDir(key === 'name' ? 'asc' : 'desc') }
  }

  function sortGroup(list) {
    if (!sortKey) return [...list].sort((a, b) => a.sort_order - b.sort_order)
    const dir = sortDir === 'asc' ? 1 : -1
    return [...list].sort((a, b) => {
      const av = a[sortKey]
      const bv = b[sortKey]
      if (typeof av === 'string') return av.localeCompare(bv, 'ru') * dir
      // Пустой CPO (нет договоров) всегда внизу, независимо от направления
      // сортировки — иначе каналы без единого договора занимают весь верх.
      if (av == null) return 1
      if (bv == null) return -1
      return (av - bv) * dir
    })
  }

  const total = sumRows(rows)

  if (loading) return <div className="loading">Загрузка...</div>

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.5px', marginBottom: 4 }}>
            Период
          </div>
          <div style={{ fontSize: 16, fontWeight: 600 }}>{monthLabel(month)}</div>
        </div>
        <div style={{ width: 320 }}>
          <select className="form-select" style={{ width: '100%' }} value={month} onChange={e => setMonth(e.target.value)}>
            {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        </div>
      </div>

      <div className="table-wrap">
        <table className="table-compact table-sticky-first">
          <thead>
            <tr>
              {COLUMNS.map(c => (
                <th
                  key={c.key}
                  style={{ textAlign: c.align, cursor: 'pointer', whiteSpace: 'nowrap' }}
                  onClick={() => toggleSort(c.key)}
                >
                  {c.label}{sortKey === c.key ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <tr className="totals-row" style={{ background: 'var(--green-bg)', borderBottom: '2px solid var(--green-primary)' }}>
              <td style={{ fontWeight: 700 }}>Итого</td>
              <td style={{ textAlign: 'right', fontWeight: 700 }}>{formatMoney(total.spend)}</td>
              <td style={{ textAlign: 'right', fontWeight: 700 }}>{formatNum(total.leads)}</td>
              <td style={{ textAlign: 'right', fontWeight: 700 }}>{formatNum(total.contracts)}</td>
              <td style={{ textAlign: 'right', fontWeight: 700 }}>{total.cpo == null ? '—' : formatMoney(total.cpo)}</td>
            </tr>

            {GROUPS.map(g => {
              const groupRows = sortGroup(rows.filter(r => r.direction === g.id))
              if (groupRows.length === 0) return null
              const sub = sumRows(groupRows)
              return (
                <React.Fragment key={g.id}>
                  <tr style={{ background: 'var(--bg)' }}>
                    <td style={{ fontWeight: 700, fontSize: 12, letterSpacing: '0.5px' }}>{g.label}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatMoney(sub.spend)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatNum(sub.leads)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatNum(sub.contracts)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{sub.cpo == null ? '—' : formatMoney(sub.cpo)}</td>
                  </tr>
                  {groupRows.map(r => (
                    <tr
                      key={r.channelId || 'orphan'}
                      style={{ cursor: r.channelId ? 'pointer' : 'default' }}
                      onClick={() => r.channelId && onOpenChannel(r.channelId)}
                    >
                      <td style={{ paddingLeft: 24 }}>{r.name}</td>
                      <td style={{ textAlign: 'right' }}>{formatMoney(r.spend)}</td>
                      <td style={{ textAlign: 'right' }}>{formatNum(r.leads)}</td>
                      <td style={{ textAlign: 'right' }}>{formatNum(r.contracts)}</td>
                      <td style={{ textAlign: 'right' }}>{r.cpo == null ? '—' : formatMoney(r.cpo)}</td>
                    </tr>
                  ))}
                </React.Fragment>
              )
            })}
          </tbody>
        </table>
      </div>

      <div style={{ marginTop: 10, fontSize: 12, color: 'var(--text-muted)' }}>
        Лиды — по дате создания лида. Договор — сделка, стоящая сейчас на договорной стадии воронки
        «Автоправо. Продажи» или «Аварийные комиссары»; относится к месяцу создания породившего её лида.
        CPO = расход / договоры.
      </div>
    </div>
  )
}
