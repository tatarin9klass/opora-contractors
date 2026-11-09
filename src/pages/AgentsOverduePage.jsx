import React, { useState } from 'react'
import { overdueBuckets } from '../lib/agents.js'
import { formatNum, plural } from '../lib/helpers.js'

// ============================================================================
// «Просрочки» — кто перестал передавать.
//
// СЧИТАЕМ ПО ЛИДАМ, А НЕ ПО СДЕЛКАМ. Отсутствие сделок не делает агента
// просроченным: он мог привести лид вчера, а сделка ещё в работе. Молчание
// видно только по лидам.
//
// ПОРОГИ НАКОПИТЕЛЬНЫЕ: «более 30» включает и тех, кто молчит сто дней.
// Так и спрошено, и так честнее — иначе плитка «более 30» показывала бы
// меньше, чем есть на самом деле замолчавших.
//
// АГЕНТ БЕЗ ЕДИНОГО ЛИДА — НЕ ПРОСРОЧКА, А ОТДЕЛЬНАЯ СТРОКА. Его не
// возвращают, его впервые активируют, и разговор с ним другой. Таких в
// сети примерно половина, и сложи мы их с остальными, плитка «более 90»
// стала бы списком, с которым невозможно работать.
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

function Список({ list, показыватьДни = true }) {
  return (
    <div className="rop-stuck" style={{ marginBottom: 14 }}>
      {list.slice(0, 200).map(a => (
        <div key={a.agent_id} className="rop-stuck-row">
          {показыватьДни && (
            <span className="rop-stuck-days">{formatNum(a.дней_без_лида)} дн.</span>
          )}
          <span className="rop-stuck-title">{a.агент}</span>
          <span className="rop-stuck-stage">{a.стадия || '—'}</span>
          <span className="rop-stuck-sum">
            {a.лидов_всего ? `${formatNum(a.лидов_всего)} ${plural(a.лидов_всего, 'лид', 'лида', 'лидов')}` : 'ни одного'}
          </span>
        </div>
      ))}
      {list.length > 200 && (
        <div className="portal-muted" style={{ marginTop: 6 }}>
          показаны первые двести из {formatNum(list.length)}
        </div>
      )}
    </div>
  )
}

export default function AgentsOverduePage({ data }) {
  const [open, setOpen] = useState(null)
  const b = overdueBuckets(data?.overdue || [])
  const toggle = (id) => setOpen(open === id ? null : id)

  const карточки = [
    { id: 'd30', label: 'Молчат более 30 дней', list: b.d30, tone: '',
      note: 'включая тех, кто молчит дольше' },
    { id: 'd60', label: 'Более 60 дней', list: b.d60, tone: 'warn',
      note: 'включая тех, кто молчит дольше' },
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
          наверху на эту вкладку не влияет. Щёлкните по плитке, чтобы
          увидеть поимённо.
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
          <Список list={c.list} показыватьДни={c.id !== 'никогда'} />
        </div>
      ))}

      <div className="rop-footer">
        Пороги накопительные: тот, кто молчит сто дней, посчитан во всех
        трёх плитках. Так цифра в плитке совпадает с длиной списка под ней.
        Агенты без единого лида вынесены отдельно: это не просрочка, а люди,
        которых ни разу не активировали, — таких в сети около половины, и в
        общем списке они утопили бы тех, кого ещё можно вернуть. Всего
        карточек агентов: {formatNum(b.всего)}.
      </div>
    </>
  )
}
