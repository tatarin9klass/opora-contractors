import React, { useState } from 'react'
import Sidebar from './components/Sidebar.jsx'
import DashboardPage from './pages/DashboardPage.jsx'
import ContractorsPage from './pages/ContractorsPage.jsx'
import PassportPage from './pages/PassportPage.jsx'
import ImportPage from './pages/ImportPage.jsx'

const PAGE_TITLES = {
  dashboard: 'Дашборд',
  contractors: 'Подрядчики',
  import: 'Импорт данных',
}

function ImportPlaceholder() {
  return (
    <div className="empty-state" style={{ marginTop: 60 }}>
      <div className="empty-state-icon">📥</div>
      <h3>Импорт данных из Битрикса</h3>
      <p style={{ maxWidth: 400, margin: '8px auto 0' }}>
        Здесь будет загрузка еженедельного Excel-файла с листами: Лиды, Квалы, Встречи, Сделки.<br /><br />
        Раздел в разработке.
      </p>
    </div>
  )
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
          {page === 'import' && <ImportPage />}
        </div>
      </div>
    </div>
  )
}
