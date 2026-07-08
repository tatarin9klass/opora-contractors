import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { getStatusClass, cplClass, cpqlClass, formatMoney, formatDate } from '../lib/helpers.js'
import AddContractorModal from '../components/AddContractorModal.jsx'

const STATUS_FILTERS = [
  { label: 'Все', value: 'all' },
  { label: 'Активные', value: 'active' },
  { label: 'Тест', value: 'test' },
  { label: 'Пауза', value: 'pause' },
  { label: 'Неактивные', value: 'inactive' },
  { label: '⛔ Не брать', value: 'notake' },
]

// Столбцы доступные для сортировки: ключ -> поле в данных
const SORTABLE_COLUMNS = [
  { key: 'name', label: 'Подрядчик', field: r => (r.short_name || r.name || '').toLowerCase() },
  { key: 'leads', label: 'Лиды МТД', field: r => r.leads_mtd || 0 },
  { key: 'spend', label: 'Расход МТД', field: r => r.spend_mtd || 0 },
  { key: 'cpl', label: 'CPL', field: r => r.cpl_mtd ?? -1 },
  { key: 'quals', label: 'Квалы', field: r => r.quals_mtd || 0 },
  { key: 'cpql', label: 'CPQL', field: r => r.cpql_mtd ?? -1 },
  { key: 'meetings', label: 'Встречи', field: r => r.meetings_mtd || 0 },
  { key: 'deals', label: 'Сделки', field: r => r.deals_mtd || 0 },
  { key: 'updated', label: 'Обновлён', field: r => r.updated_at || '' },
]

export default function ContractorsPage({ onOpenPassport }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('all')
  const [typeFilter, setTypeFilter] = useState('')
  const [types, setTypes] = useState([])
  const [showAdd, setShowAdd] = useState(false)
  const [sortKey, setSortKey] = useState(null)
  const [sortDir, setSortDir] = useState('desc') // 'asc' | 'desc'

  async function load() {
    setLoading(true)
    const { data } = await supabase.from('contractor_mtd').select('*')
    setRows(data || [])
    setLoading(false)
  }

  useEffect(() => {
    load()
    supabase.from('contractor_types').select('*').order('name').then(({ data }) => setTypes(data || []))
  }, [])

  function toggleSort(key) {
    if (sortKey === key) {
      setSortDir(d => (d === 'asc' ? 'desc' : 'asc'))
    } else {
      setSortKey(key)
      setSortDir(key === 'name' ? 'asc' : 'desc') // числовые по убыванию по умолчанию, имя по алфавиту
    }
  }

  const filtered = rows.filter(r => {
    if (search && !r.name?.toLowerCase().includes(search.toLowerCase()) && !r.short_name?.toLowerCase().includes(search.toLowerCase())) return false
    if (typeFilter && r.type !== typeFilter) return false
    if (statusFilter === 'active') return r.is_active && r.status !== 'Тест'
    if (statusFilter === 'test') return r.status === 'Тест'
    if (statusFilter === 'pause') return r.status === 'Пауза'
    if (statusFilter === 'inactive') return !r.is_active && r.status !== 'Не брать' && r.status !== 'Пауза'
    if (statusFilter === 'notake') return r.status === 'Не брать'
    return true
  })

  const sortedRows = [...filtered]
  if (sortKey) {
    const col = SORTABLE_COLUMNS.find(c => c.key === sortKey)
    if (col) {
      sortedRows.sort((a, b) => {
        const av = col.field(a)
        const bv = col.field(b)
        if (typeof av === 'string') {
          const cmp = av.localeCompare(bv)
          return sortDir === 'asc' ? cmp : -cmp
        }
        const cmp = av - bv
        return sortDir === 'asc' ? cmp : -cmp
      })
    }
  }

  const activeCount = rows.filter(r => r.is_active).length
  const testCount = rows.filter(r => r.status === 'Тест').length
  const alertCount = rows.filter(r => r.is_active && r.cpl_mtd > 1500).length

  function SortIcon({ colKey }) {
    if (sortKey !== colKey) return <span style={{ opacity: 0.25, marginLeft: 4 }}>↕</span>
    return <span style={{ marginLeft: 4, color: 'var(--green-primary)' }}>{sortDir === 'asc' ? '↑' : '↓'}</span>
  }

  return (
    <div>
      <div className="kpi-row">
        <div className="kpi-card green">
          <div className="kpi-label">Активных</div>
          <div className="kpi-value">{activeCount}</div>
          <div className="kpi-sub">из {rows.length} всего</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">На тесте</div>
          <div className="kpi-value">{testCount}</div>
        </div>
        <div className="kpi-card yellow">
          <div className="kpi-label">Превышение CPL</div>
          <div className="kpi-value">{alertCount}</div>
          <div className="kpi-sub">подрядчиков в зоне риска</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Всего подрядчиков</div>
          <div className="kpi-value">{rows.length}</div>
        </div>
      </div>

      <div className="filters-bar">
        {STATUS_FILTERS.map(f => (
          <button key={f.value} className={`filter-chip ${statusFilter === f.value ? 'active' : ''}`} onClick={() => setStatusFilter(f.value)}>
            {f.label}
          </button>
        ))}
      </div>

      <div className="table-wrap">
        <div className="table-toolbar">
          <input className="search-input" placeholder="🔍 Поиск по названию..." value={search} onChange={e => setSearch(e.target.value)} />
          <select className="filter-select" value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
            <option value="">Все типы</option>
            {types.map(t => <option key={t.id} value={t.name}>{t.name}</option>)}
          </select>
          <div style={{ marginLeft: 'auto' }}>
            <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Добавить подрядчика</button>
          </div>
        </div>

        <div className="table-scroll">
          {loading ? (
            <div className="loading">Загрузка...</div>
          ) : sortedRows.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">🤝</div>
              <h3>Подрядчики не найдены</h3>
              <p>Измените фильтры или добавьте нового подрядчика</p>
            </div>
          ) : (
            <table>
              <thead>
                <tr>
                  {SORTABLE_COLUMNS.slice(0, 1).map(col => (
                    <th key={col.key} onClick={() => toggleSort(col.key)} style={{ cursor: 'pointer', userSelect: 'none' }}>
                      {col.label}<SortIcon colKey={col.key} />
                    </th>
                  ))}
                  <th>Тип</th>
                  <th>Статус</th>
                  {SORTABLE_COLUMNS.slice(1).map(col => (
                    <th key={col.key} onClick={() => toggleSort(col.key)} style={{ cursor: 'pointer', userSelect: 'none', textAlign: col.key === 'updated' ? 'left' : 'right' }}>
                      {col.label}<SortIcon colKey={col.key} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {sortedRows.map(r => (
                  <tr key={r.contractor_id}>
                    <td><span className="td-name" onClick={() => onOpenPassport(r.contractor_id)}>{r.short_name || r.name}</span></td>
                    <td className="td-muted">{r.type || '—'}</td>
                    <td><span className={`badge ${getStatusClass(r.status)}`}>{r.status}</span></td>
                    <td style={{ textAlign: 'right' }} className="metric">{r.leads_mtd || 0}</td>
                    <td style={{ textAlign: 'right' }}>{formatMoney(r.spend_mtd)}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span className={`metric ${cplClass(r.cpl_mtd)}`}>{r.cpl_mtd ? formatMoney(r.cpl_mtd) : '—'}</span>
                    </td>
                    <td style={{ textAlign: 'right' }} className="metric">{r.quals_mtd || 0}</td>
                    <td style={{ textAlign: 'right' }}>
                      <span className={`metric ${cpqlClass(r.cpql_mtd)}`}>{r.cpql_mtd ? formatMoney(r.cpql_mtd) : '—'}</span>
                    </td>
                    <td style={{ textAlign: 'right' }} className="metric">{r.meetings_mtd || 0}</td>
                    <td style={{ textAlign: 'right' }} className="metric">{r.deals_mtd || 0}</td>
                    <td className="td-muted" style={{ fontSize: 11 }}>{formatDate(r.updated_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {showAdd && (
        <AddContractorModal onClose={() => setShowAdd(false)} onSaved={(c) => { setShowAdd(false); load(); onOpenPassport(c.id) }} />
      )}
    </div>
  )
}
