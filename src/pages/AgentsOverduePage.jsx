import React, { useState } from 'react'
import { overdueBuckets } from '../lib/agents.js'
import { useSort, Th } from '../lib/sortable.jsx'
import { formatNum, plural } from '../lib/helpers.js'

// ============================================================================
// «Просрочки» — кто перестал передавать.
//
// СЧИТАЕМ ПО ЛИДАМ, А НЕ ПО СДЕЛКАМ. Отсутствие сделок не делает агента
// просроченным: он мог привести лид вчера, а сделка ещё в работе. Молчание
// видно только по лидам.
//
// ГРУППЫ НЕ ПЕРЕСЕКАЮТСЯ: каждый агент ровно в одной. Накопительные пороги
// на живых данных давали 305 / 210 / 154 — по таким числам нельзя сказать,
// сколько людей в какой беде, потому что это одни и те же люди трижды. Без
// пересечений те же данные читаются как 95 / 56 / 154, и сразу видно, что
// основная масса не «подзабыла», а потеряна.
//
// АГЕНТ БЕЗ ЕДИНОГО ЛИДА НЕ ПОПАДАЕТ НИ В ОДНУ ГРУППУ ПРОСРОЧКИ. Его не
// возвращают, его впервые активируют, и разговор с ним другой.
// ============================================================================

function Bucket({ label, list, tone, note, open, onToggle }) {
  return (
    <div className={`rop-metric ${tone} ${list.length ? 'clickable' : ''}`}
         onClick={list.length ? onToggle : undefined}
         style={{ cursor: list.length ? 'pointer' : 'default' }}>
      <div className="rop-metric-label">
        {list.length ? (open ? '▾ ' : '▸ ') : ''}{label}
      </div>
      <div className="rop-metric-value">{formatNum(list.length)}</div>
      <div className="rop-metric-sub">{note}</div>
    </div>
  )
}

function Список({ list, дни = true }) {
  const { sort, onSort, apply } = useSort(дни ? 'дней_без_лида' : 'агент', дни ? 'desc' : 'asc')
  const rows = apply(list)
  return (
    <div className="table-wrap">
      <div className="table-scroll">
        <table className="table-compact rop-table">
          <thead>
            <tr>
              <Th sort={sort} onSort={onSort} k="агент" textual>Агент</Th>
              <Th sort={sort} onSort={onSort} k="стадия" textual>Стадия</Th>
              {дни && (
                <Th sort={sort} onSort={onSort} k="дней_без_лида" className="portal-num">
                  Дней без лида
                </Th>
              )}
              <Th sort={sort} onSort={onSort} k="лидов_всего" className="portal-num">
                Лидов всего
              </Th>
            </tr>
          </thead>
          <tbody>
            {rows.map(a => (
              <tr key={a.agent_id}>
                <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{a.агент}</td>
                <td>{a.стадия || <span className="td-muted">—</span>}</td>
                {дни && <td className="portal-num">{formatNum(a.дней_без_лида)}</td>}
                <td className="portal-num">
                  {a.лидов_всего ? formatNum(a.лидов_всего) : <span className="td-muted">—</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}

export default function AgentsOverduePage({ data }) {
  const [open, setOpen] = useState(null)
  const b = overdueBuckets(data?.overdue || [])
  const toggle = (id) => setOpen(open === id ? null : id)

  const карточки = [
    { id: 'd30', label: 'Молчат 30–60 дней', list: b.d30, tone: '',
      note: 'ещё можно вернуть' },
    { id: 'd60', label: '60–90 дней', list: b.d60, tone: 'warn',
      note: 'уходят' },
    { id: 'd90', label: 'Более 90 дней', list: b.d90, tone: 'bad',
      note: 'практически потеряны' },
    { id: 'никогда', label: 'Ни одного лида', list: b.никогда, tone: '',
      note: 'не просрочка — не активированы ни разу' },
  ]

  return (
    <>
      <div className="portal-section-head">
        <h2 className="portal-section-title">Просрочки</h2>
        <p className="portal-section-note">
          Считается по дате последнего лида, снимок на сегодня — период
          наверху на эту вкладку не влияет. Группы не пересекаются: каждый
          агент ровно в одной. Щёлкните по плитке, чтобы увидеть поимённо.
        </p>
      </div>

      <div className="rop-metrics">
        {карточки.map(c => (
          <Bucket key={c.id} {...c} open={open === c.id} onToggle={() => toggle(c.id)} />
        ))}
      </div>

      {карточки.filter(c => open === c.id).map(c => (
        <div key={c.id}>
          <div className="portal-section-head">
            <h2 className="portal-section-title">{c.label}</h2>
          </div>
          <Список list={c.list} дни={c.id !== 'никогда'} />
        </div>
      ))}

      <div className="rop-footer">
        Агенты без единого лида вынесены отдельно: это не просрочка, а люди,
        которых ни разу не активировали, — в общем списке они утопили бы тех,
        кого ещё можно вернуть. Передавали за последние тридцать дней{' '}
        {formatNum(b.активны)}{' '}
        {plural(b.активны, 'агент', 'агента', 'агентов')} — они здесь не
        показаны. Всего карточек агентов: {formatNum(b.всего)}.
      </div>
    </>
  )
}
