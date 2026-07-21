import React, { useState } from 'react'
import Sidebar from './components/Sidebar.jsx'
import DashboardPage from './pages/DashboardPage.jsx'
import ContractorsPage from './pages/ContractorsPage.jsx'
import PassportPage from './pages/PassportPage.jsx'
import ImportPage from './pages/ImportPage.jsx'
import WeeklyExpensesPage from './pages/WeeklyExpensesPage.jsx'
import LoginPage from './pages/LoginPage.jsx'
import HelpPage from './pages/HelpPage.jsx'
import { AuthProvider, useAuth } from './lib/auth.jsx'

const PAGE_TITLES = {
  dashboard: 'Дашборд',
  contractors: 'Подрядчики',
  import: 'Импорт данных',
  expenses: 'Ввод расходов',
  help: 'Инструкция',
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

function AppShell() {
  const { session, profile, isAdmin, loading, signOut } = useAuth()
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

  if (loading) return <div className="loading">Загрузка...</div>
  if (!session) return <LoginPage />
  if (!profile) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 12 }}>
        <div style={{ fontSize: 15, fontWeight: 600 }}>Доступ не настроен</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', maxWidth: 320, textAlign: 'center' }}>
          Вход выполнен, но для этого аккаунта не заведена запись доступа. Обратитесь к администратору.
        </div>
        <button className="btn btn-secondary btn-sm" onClick={signOut}>Выйти</button>
      </div>
    )
  }

  // Раздел "Ввод расходов"/"Импорт данных" — write-инструменты без
  // информационной ценности для роли "просмотр", скрываем их целиком из
  // навигации, а не разрешаем открыть в disabled-виде.
  const safePage = !isAdmin && (page === 'import' || page === 'expenses') ? 'dashboard' : page
  const title = safePage === 'passport' ? 'Паспорт подрядчика' : PAGE_TITLES[safePage] || ''

  return (
    <div className="layout">
      <Sidebar page={safePage} setPage={p => { setPage(p); setPassportId(null) }} isAdmin={isAdmin} />
      <div className="main">
        <div className="topbar">
          <div className="topbar-title">{title}</div>
          <div className="topbar-actions" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>ЮК Опора · Новосибирск</span>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{session.user.email}{!isAdmin ? ' · только просмотр' : ''}</span>
            <button className="btn btn-ghost btn-sm" onClick={signOut}>Выйти</button>
          </div>
        </div>
        <div className="page-content">
          {safePage === 'dashboard' && <DashboardPage onOpenPassport={openPassport} isAdmin={isAdmin} />}
          {safePage === 'contractors' && <ContractorsPage onOpenPassport={openPassport} isAdmin={isAdmin} />}
          {safePage === 'passport' && passportId && <PassportPage contractorId={passportId} onBack={backToList} isAdmin={isAdmin} />}
          {safePage === 'import' && <ImportPage />}
          {safePage === 'expenses' && <WeeklyExpensesPage />}
          {safePage === 'help' && <HelpPage />}
        </div>
      </div>
    </div>
  )
}

export default function App() {
  return (
    <AuthProvider>
      <AppShell />
    </AuthProvider>
  )
}
