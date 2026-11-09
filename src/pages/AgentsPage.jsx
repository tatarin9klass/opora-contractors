import React, { useEffect, useMemo, useState } from 'react'
import { useAuth } from '../lib/auth.jsx'
import { todayISO } from '../lib/dateContext.js'
import { loadAgents, periodBounds, recentMonths } from '../lib/agents.js'
import AgentsMainPage from './AgentsMainPage.jsx'
import AgentsListPage from './AgentsListPage.jsx'
import AgentsOverduePage from './AgentsOverduePage.jsx'

// ============================================================================
// Кабинет руководителя агентской сети.
//
// ОДИН И ТОТ ЖЕ ЭКРАН В ДВУХ ОБЛИЧЬЯХ, как и у РОПа. Руководителю сети он
// открывается целиком, без меню и без направлений; нам — разделом внутри
// приложения. Намеренно один компонент: иначе через месяц это будут два
// разных экрана, расходящихся при первой же правке.
//
// ЧЕГО ЗДЕСЬ НЕТ НИ В КАКОМ ВИДЕ: расходов, стоимости лида, подрядчиков,
// отделов продаж, Автоправо. И не потому, что их не выводит интерфейс:
// роли agentlead база не отдаёт ничего, кроме пяти витрин agents_portal_*
// (см. 20261109_agents_schema.sql).
//
// ПЕРИОД ОБЩИЙ НА ДВЕ ВКЛАДКИ ИЗ ТРЁХ. «Просрочки» — снимок на сегодня:
// молчание не бывает «за прошлый месяц», и переключатель на него не
// влияет. Про это написано прямо на вкладке, чтобы не пришлось гадать.
// ============================================================================

const TABS = [
  { id: 'main', label: 'Главная' },
  { id: 'agents', label: 'Агенты' },
  { id: 'overdue', label: 'Просрочки' },
]

const MODES = [
  { id: 'month', label: 'Месяц' },
  { id: 'week', label: 'Неделя' },
  { id: 'range', label: 'Период' },
]

export default function AgentsPage({ standalone = false }) {
  const { session, signOut } = useAuth()
  const [tab, setTab] = useState('main')
  const [mode, setMode] = useState('month')
  const [anchor, setAnchor] = useState(todayISO())
  const [from, setFrom] = useState(todayISO())
  const [to, setTo] = useState(todayISO())
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const months = useMemo(() => recentMonths(12), [])
  const bounds = useMemo(() => periodBounds(mode, anchor, from, to), [mode, anchor, from, to])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError('')
    loadAgents(bounds.from, bounds.to)
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(String(e?.message || e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [bounds.from, bounds.to])

  const label = bounds.from === bounds.to
    ? bounds.from.split('-').reverse().join('.')
    : `${bounds.from.split('-').reverse().join('.')} — ${bounds.to.split('-').reverse().join('.')}`

  // Пустая сеть — почти наверняка не пустая сеть, а незапущенный импорт.
  // Показать нули и промолчать значит отправить человека искать проблему
  // в агентах вместо раздела «Импорт данных».
  const пусто = !loading && data && !(data.funnel || []).some(s => s.агентов)
    && !(data.overdue || []).length

  const body = (
    <>
      <div className="rop-tabs">
        {TABS.map(t => (
          <button key={t.id} className={`rop-tab ${tab === t.id ? 'active' : ''}`}
                  onClick={() => setTab(t.id)}>{t.label}</button>
        ))}
      </div>

      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

      {tab !== 'overdue' && (
        <div className="portal-period" style={{ marginBottom: 18 }}>
          <div className="portal-chips">
            {MODES.map(m => (
              <button key={m.id} className={`filter-chip ${mode === m.id ? 'active' : ''}`}
                      onClick={() => setMode(m.id)}>{m.label}</button>
            ))}
          </div>
          <div className="portal-period-detail">
            {mode === 'month' && (
              <select className="filter-select" value={anchor.slice(0, 8) + '01'}
                      onChange={e => setAnchor(e.target.value)}>
                {months.map(m => <option key={m.start} value={m.start}>{m.label}</option>)}
              </select>
            )}
            {mode === 'range' && (
              <>
                <input className="form-input portal-date" type="date" value={from}
                       max={todayISO()} onChange={e => setFrom(e.target.value)} />
                <span className="portal-muted">—</span>
                <input className="form-input portal-date" type="date" value={to}
                       max={todayISO()} onChange={e => setTo(e.target.value)} />
              </>
            )}
            <span className="portal-period-label">{label}</span>
          </div>
        </div>
      )}

      {loading && !data && <div className="loading">Загрузка...</div>}

      {пусто && (
        <div className="empty-state" style={{ marginTop: 20 }}>
          <div className="empty-state-icon">📭</div>
          <h3>Данных об агентах нет</h3>
          <p>
            Похоже, импорт ещё не запускали: в разделе «Импорт данных» есть
            кнопка «Загрузить агентскую сеть». Если вы её уже нажимали —
            значит загрузка не дошла до конца, и стоит нажать ещё раз.
          </p>
        </div>
      )}

      {!пусто && data && (
        <div className={loading ? 'portal-fading' : ''}>
          {tab === 'main' && <AgentsMainPage data={data} label={label} />}
          {tab === 'agents' && <AgentsListPage data={data} label={label} />}
          {tab === 'overdue' && <AgentsOverduePage data={data} />}
        </div>
      )}
    </>
  )

  if (!standalone) return body

  return (
    <div className="portal">
      <div className="portal-topbar">
        <div className="portal-brand">
          <div className="portal-brand-name">Агентская сеть</div>
          <div className="portal-brand-sub">ЮК Опора</div>
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
