import React from 'react'

export default function Sidebar({ page, setPage }) {
  const items = [
    { id: 'dashboard', icon: '📊', label: 'Дашборд' },
    { id: 'contractors', icon: '🤝', label: 'Подрядчики' },
    { id: 'weekly', icon: '📅', label: 'Недельный факт' },
  ]

  return (
    <div className="sidebar">
      <div className="sidebar-logo">
        <h1>ЮК Опора</h1>
        <p>Управление подрядчиками</p>
      </div>
      <nav className="sidebar-nav">
        {items.map(item => (
          <div
            key={item.id}
            className={`nav-item ${page === item.id || (page.startsWith('passport') && item.id === 'contractors') ? 'active' : ''}`}
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
