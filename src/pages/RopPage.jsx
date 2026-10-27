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
// ПЛАНЫ СТАВИТ САМ РУКОВОДИТЕЛЬ ОТДЕЛА, по своим менеджерам. Право на это
// проверяется в базе, а не в интерфейсе: политика на rop_plans пускает его
// к строкам своего отдела и никуда больше.
//
// ТРИ ВКЛАДКИ, И ЭТО НАМЕРЕННО. Были пять: «Сегодня» со списком дел,
// «Итоги» с одиннадцатью блоками, «Портфель» с запасом сделок. Кабинет,
// который объясняет всё, не отвечает на главный вопрос — сколько договоров
// и сколько осталось. Экраны «Сегодня» и «Портфель» не удалены из кода, они
// просто не подключены: вернуть их — одна строка здесь.
// ============================================================================

const TABS = [
  { id: 'dash', label: 'Главное' },
  { id: 'managers', label: 'Менеджеры' },
  { id: 'plans', label: 'Планы' },
]

export default function RopPage({ standalone = false }) {
  const { session, signOut } = useAuth()
  const [tab, setTab] = useState('dash')

  // Отделов продаж два, и у каждого свой руководитель. База отдаёт роли rop
  // только её собственный, поэтому список из одной строки означает «выбирать
  // не из чего» — переключатель тогда не показывается вовсе.
  const [teams, setTeams] = useState(null)
  const [team, setTeam] = useState(null)
  useEffect(() => {
    supabase.from('rop_portal_teams').select('*').order('sort_order')
      .then(({ data }) => {
        setTeams(data || [])
        if (data && data.length) setTeam(data[0].отдел)
      })
  }, [])

  const tabs = TABS

  // Отделов нет ни одного — значит человеку не назначен отдел, и все витрины
  // вернут пустоту. Показать в этом случае нули было бы худшим из возможных:
  // руководитель решил бы, что отдел не работает, и пошёл бы разбираться не
  // туда. Экран обязан сказать, что дело в доступе.
  const noTeam = teams !== null && teams.length === 0

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
        {teams && teams.length > 1 && (
          <select className="filter-select rop-team" value={team || ''}
                  onChange={e => setTeam(e.target.value)}>
            {(teams || []).map(t => <option key={t.отдел} value={t.отдел}>{t.название}</option>)}
          </select>
        )}
      </div>
      {noTeam && (
        <div className="empty-state" style={{ marginTop: 24 }}>
          <div className="empty-state-icon">🔧</div>
          <h3>Отдел не назначен</h3>
          <p>
            Доступ выдан, но не указано, каким отделом вы руководите, — поэтому
            показывать нечего. Это настройка на нашей стороне: сообщите
            администратору, и кабинет откроется без каких-либо действий с вашей
            стороны.
          </p>
        </div>
      )}
      {!noTeam && tab === 'dash' && <RopDashboardPage team={team} />}
      {!noTeam && tab === 'managers' && <RopManagersPage team={team} />}
      {!noTeam && tab === 'plans' && <RopPlansPage team={team} />}
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
