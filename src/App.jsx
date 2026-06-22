import React, { useState } from 'react'
import Sidebar from './components/Sidebar.jsx'
import DashboardPage from './pages/DashboardPage.jsx'
import ContractorsPage from './pages/ContractorsPage.jsx'
import PassportPage from './pages/PassportPage.jsx'
import WeeklyPage from './pages/WeeklyPage.jsx'

const PAGE_TITLES = {
  dashboard: 'Дашборд',
  contractors: 'Подрядчики',
  weekly: 'Недельный факт',
}

export default function App() {
  const [page, setPage] = useState('dashboard')
  const [passportId, setPassportId] = useState(null)

  function openPassport(id) {
    setPassportId(id)
    setPage('passport')
  }

  function backToList() {
    setPage('contractors')
    setPassportId(null)
  }

  const title = page === 'passport' ? 'Паспорт подрядчика' : PAGE_TITLES[page] || ''

  return (
    <div className="layout">
      <Sidebar page={page} setPage={p => { setPage(p); setPassportId(null) }} />
      <div className="main">
        <div className="topbar">
          <div className="topbar-title">{title}</div>
          <div className="topbar-actions">
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>ЮК Опора · Новосибирск</span>
          </div>
        </div>
        <div className="page-content">
          {page === 'dashboard' && <DashboardPage onOpenPassport={openPassport} />}
          {page === 'contractors' && <ContractorsPage onOpenPassport={openPassport} />}
          {page === 'passport' && passportId && <PassportPage contractorId={passportId} onBack={backToList} />}
          {page === 'weekly' && <WeeklyPage />}
        </div>
      </div>
    </div>
  )
}
