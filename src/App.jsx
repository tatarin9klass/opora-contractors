import React, { useState } from 'react'
import Sidebar from './components/Sidebar.jsx'
import DashboardPage from './pages/DashboardPage.jsx'
import ContractorsPage from './pages/ContractorsPage.jsx'
import PassportPage from './pages/PassportPage.jsx'
import ImportPage from './pages/ImportPage.jsx'
import WeeklyExpensesPage from './pages/WeeklyExpensesPage.jsx'
import LoginPage from './pages/LoginPage.jsx'
import HelpPage from './pages/HelpPage.jsx'
import RegularManagementPage from './pages/RegularManagementPage.jsx'
import ChannelsPage from './pages/ChannelsPage.jsx'
import ChannelPassportPage from './pages/ChannelPassportPage.jsx'
import AvtpImportPage from './pages/AvtpImportPage.jsx'
import ApExpensesPage from './pages/ApExpensesPage.jsx'
import { AuthProvider, useAuth } from './lib/auth.jsx'

const PAGE_TITLES = {
  dashboard: 'Дашборд',
  contractors: 'Подрядчики',
  import: 'Импорт данных',
  expenses: 'Ввод расходов',
  regmgmt: 'Регулярный менеджмент',
  help: 'Инструкция',
  channels: 'Каналы — Автоправо',
  apimport: 'Импорт данных — Автоправо',
  apexpenses: 'Ввод расходов — Автоправо',
}

// Стартовый раздел каждого направления. Приложение всегда открывается на БФЛ.
const HOME_PAGE = { bfl: 'dashboard', avtp: 'channels' }

// Разделы, которые относятся к направлению АВТОПРАВО — нужны, чтобы при
// переключении направления не остаться на чужом экране.
const AVTP_PAGES = new Set(['channels', 'channel', 'apimport', 'apexpenses'])

// Чисто write-инструменты: без информационной ценности для роли "просмотр",
// скрываем их целиком из навигации, а не разрешаем открыть в disabled-виде.
const ADMIN_ONLY_PAGES = new Set(['import', 'expenses', 'apimport', 'apexpenses'])

function AppShell() {
  const { session, profile, isAdmin, loading, signOut } = useAuth()
  const [direction, setDirectionState] = useState('bfl')
  const [page, setPage] = useState('dashboard')
  const [passportId, setPassportId] = useState(null)
  const [channelId, setChannelId] = useState(null)

  function setDirection(next) {
    setDirectionState(next)
    setPage(HOME_PAGE[next] || 'dashboard')
    setPassportId(null)
    setChannelId(null)
  }

  function openPassport(id) {
    setPassportId(id)
    setPage('passport')
  }

  function backToList() {
    setPage('contractors')
    setPassportId(null)
  }

  function openChannel(id) {
    setChannelId(id)
    setPage('channel')
  }

  function backToChannels() {
    setPage('channels')
    setChannelId(null)
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

  const safePage = !isAdmin && ADMIN_ONLY_PAGES.has(page) ? (HOME_PAGE[direction] || 'dashboard') : page
  // Направление считаем по самому разделу, а не по стейту — так подсветка меню
  // и заголовок не разъедутся, если раздел и направление на миг разошлись.
  const safeDirection = AVTP_PAGES.has(safePage) ? 'avtp' : 'bfl'
  const title = safePage === 'passport'
    ? 'Паспорт подрядчика'
    : safePage === 'channel'
      ? 'Паспорт канала'
      : PAGE_TITLES[safePage] || ''

  return (
    <div className="layout">
      <Sidebar
        page={safePage}
        setPage={p => { setPage(p); setPassportId(null); setChannelId(null) }}
        isAdmin={isAdmin}
        direction={safeDirection}
        setDirection={setDirection}
      />
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
          {safePage === 'regmgmt' && <RegularManagementPage />}
          {safePage === 'help' && <HelpPage />}
          {safePage === 'channels' && <ChannelsPage onOpenChannel={openChannel} />}
          {safePage === 'channel' && channelId && <ChannelPassportPage channelId={channelId} onBack={backToChannels} isAdmin={isAdmin} />}
          {safePage === 'apimport' && <AvtpImportPage />}
          {safePage === 'apexpenses' && <ApExpensesPage />}
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
