import React from 'react'

export default function Sidebar({ page, setPage, isAdmin }) {
  const items = [
    { id: 'dashboard', icon: '📊', label: 'Дашборд' },
    { id: 'contractors', icon: '🤝', label: 'Подрядчики' },
    { id: 'regmgmt', icon: '📅', label: 'Регулярный менеджмент' },
    // Чисто write-инструменты — не нужны роли "просмотр", у которой всё
    // равно нет прав ничего туда записать.
    ...(isAdmin ? [
      { id: 'import', icon: '📥', label: 'Импорт данных' },
      { id: 'expenses', icon: '💸', label: 'Ввод расходов' },
    ] : []),
    { id: 'help', icon: '❓', label: 'Инструкция' },
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
            className={`nav-item ${page === item.id || (page === 'passport' && item.id === 'contractors') ? 'active' : ''}`}
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
