import React, { useEffect, useState } from 'react'
import { useAuth } from '../lib/auth.jsx'
import { supabase } from '../lib/supabase.js'
import RopDashboardPage from './RopDashboardPage.jsx'
import RopManagersPage from './RopManagersPage.jsx'
import RopPlansPage from './RopPlansPage.jsx'

// ============================================================================
// Кабинет руководителя отдела продаж.
//
// ОДИН И ТОТ ЖЕ ЭКРАН В ДВУХ ОБЛИЧЬЯХ. Руководителю отдела он открывается
// целиком — без меню, без направлений, без единого нашего экрана, ровно как
// кабинет подрядчика. Нам он открывается разделом внутри приложения. Это
// намеренно один компонент: иначе руководитель и директор обсуждали бы два
// разных экрана, расходящихся при первой же правке.
//
// ЧЕГО ЗДЕСЬ НЕТ НИ В КАКОМ ВИДЕ: расходов, выручки направления, стоимости
// лида, подрядчиков, Автоправо, сделок чужих отделов. И дело не в том, что
// их не выводит интерфейс: база не отдаёт их роли РОПа (см. миграцию
// 20261019_rop_role) — запрос мимо приложения вернёт столько же.
//
// ВКЛАДКА «ПЛАНЫ» ЕСТЬ ТОЛЬКО У АДМИНА. План ставит руководитель
// направления; РОП свой план видит на дашборде, но изменить его не может —
// и не потому, что вкладка спрятана: политика admin_write на rop_plans
// просто не даст записи.
// ============================================================================

const TABS = [
  { id: 'dash', label: 'Общий дашборд' },
  { id: 'managers', label: 'Менеджеры' },
]

export default function RopPage({ standalone = false, isAdmin = false }) {
  const { session, signOut } = useAuth()
  const [tab, setTab] = useState('dash')

  // Отделов продаж два, и у каждого свой руководитель. База отдаёт роли rop
  // только её собственный, поэтому список из одной строки означает «выбирать
  // не из чего» — переключатель тогда не показывается вовсе.
  const [teams, setTeams] = useState([])
  const [team, setTeam] = useState(null)
  useEffect(() => {
    supabase.from('rop_portal_teams').select('*').order('sort_order')
      .then(({ data }) => {
        setTeams(data || [])
        if (data && data.length) setTeam(data[0].отдел)
      })
  }, [])

  const tabs = isAdmin ? [...TABS, { id: 'plans', label: 'Планы' }] : TABS

  const body = (
    <>
      <div className="rop-tabs">
        {tabs.map(t => (
          <button
            key={t.id}
            className={`rop-tab ${tab === t.id ? 'active' : ''}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
        {teams.length > 1 && (
          <select className="filter-select rop-team" value={team || ''}
                  onChange={e => setTeam(e.target.value)}>
            {teams.map(t => <option key={t.отдел} value={t.отдел}>{t.название}</option>)}
          </select>
        )}
      </div>
      {tab === 'dash' && <RopDashboardPage team={team} />}
      {tab === 'managers' && <RopManagersPage team={team} />}
      {tab === 'plans' && isAdmin && <RopPlansPage team={team} />}
    </>
  )

  if (!standalone) return body

  return (
    <div className="portal">
      <div className="portal-topbar">
        <div className="portal-brand">
          <div className="portal-brand-name">Отдел продаж</div>
          <div className="portal-brand-sub">воронка продажи БФЛ · ЮК Опора</div>
        </div>
        <div className="portal-topbar-right">
          <span className="portal-muted">{session?.user?.email}</span>
          <button className="btn btn-ghost btn-sm" onClick={signOut}>Выйти</button>
        </div>
      </div>
      <div className="portal-content">{body}</div>
    </div>
  )
}
