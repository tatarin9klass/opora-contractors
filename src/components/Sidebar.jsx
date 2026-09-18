import React from 'react'

// Два независимых направления в одном приложении. БФЛ — исходный контур
// (лиды → квалы → встречи → сделки, недельный ритм). АВТОПРАВО — второй
// контур с собственной логикой (лиды по префиксу источника → договоры,
// помесячно). Переключатель живёт в шапке, чтобы разделы направлений
// никогда не смешивались в одном списке.
export const DIRECTIONS = [
  { id: 'bfl', label: 'БФЛ', subtitle: 'Управление подрядчиками' },
  { id: 'avtp', label: 'АВТОПРАВО', subtitle: 'Каналы и договоры' },
]

const NAV = {
  bfl: (isAdmin) => [
    { id: 'dashboard', icon: '📊', label: 'Дашборд' },
    { id: 'contractors', icon: '🤝', label: 'Подрядчики' },
    { id: 'regmgmt', icon: '📅', label: 'РМ' },
    // Чисто write-инструменты — не нужны роли "просмотр", у которой всё
    // равно нет прав ничего туда записать.
    ...(isAdmin ? [
      { id: 'import', icon: '📥', label: 'Импорт данных' },
      { id: 'expenses', icon: '💸', label: 'Ввод расходов' },
    ] : []),
    { id: 'help', icon: '❓', label: 'Инструкция' },
  ],
  avtp: (isAdmin) => [
    { id: 'channels', icon: '📡', label: 'Каналы' },
    ...(isAdmin ? [
      { id: 'apimport', icon: '📥', label: 'Импорт данных' },
      { id: 'apexpenses', icon: '💸', label: 'Ввод расходов' },
    ] : []),
  ],
}

// Раздел, подсвечивающий пункт меню, когда открыт вложенный экран.
const PARENT_OF = { passport: 'contractors', channel: 'channels' }

export default function Sidebar({ page, setPage, isAdmin, direction, setDirection }) {
  const items = (NAV[direction] || NAV.bfl)(isAdmin)
  const meta = DIRECTIONS.find(d => d.id === direction) || DIRECTIONS[0]

  return (
    <div className="sidebar">
      <div className="sidebar-logo">
        <h1>ЮК Опора</h1>
        <p>{meta.subtitle}</p>
        <select
          className="direction-select"
          value={direction}
          onChange={e => setDirection(e.target.value)}
        >
          {DIRECTIONS.map(d => <option key={d.id} value={d.id}>{d.label}</option>)}
        </select>
      </div>
      <nav className="sidebar-nav">
        {items.map(item => (
          <div
            key={item.id}
            className={`nav-item ${page === item.id || PARENT_OF[page] === item.id ? 'active' : ''}`}
            onClick={() => setPage(item.id)}
          >
            <span className="nav-icon">{item.icon}</span>
            {item.label}
          </div>
        ))}
      </nav>
    </div>
  )
}
