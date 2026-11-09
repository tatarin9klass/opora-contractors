import React from 'react'
import { flowByStage, totals, byPrefix, aov, pct, movesMatrix } from '../lib/agents.js'
import { useSort, Th } from '../lib/sortable.jsx'
import { formatNum } from '../lib/helpers.js'
import { formatMoneyShort } from '../lib/rop.js'

// ============================================================================
// «Главная» — состояние сети и что она принесла.
//
// ВОРОНКА ПОКАЗЫВАЕТ ДВА РАЗНЫХ ЧИСЛА, И ПУТАТЬ ИХ НЕЛЬЗЯ. Крупное — сколько
// агентов стоит на этапе прямо сейчас, снимок на сегодня. Мелкие «+» и «−»
// под ним — сколько пришло и ушло за выбранный период. Первое не зависит от
// периода вообще, второе зависит целиком.
//
// «−» НА ПОСЛЕДНЕЙ СТАДИИ ВСЕГДА НОЛЬ, и это не ошибка: уходить оттуда
// некуда. Выход в Битриксе не хранится, он вычисляется как вход на
// следующую стадию.
//
// СЛУЖЕБНЫХ ЭЛЕМЕНТОВ В ВОРОНКЕ НЕТ. «Агент не найден» и «Без агента»
// лежат в тех же стадиях, что живые люди, и без их отсева канбан показывал
// фаната, которым была заглушка.
// ============================================================================

function Stage({ s, flow }) {
  const f = flow.get(s.stage_id) || { вошло: 0, вышло: 0 }
  return (
    <div className="ag-stage">
      <div className="ag-stage-name">{s.стадия}</div>
      <div className="ag-stage-count">{formatNum(s.агентов)}</div>
      <div className="ag-stage-delta">
        <span className={f.вошло ? 'up' : 'zero'}>+{formatNum(f.вошло)}</span>
        <span className={f.вышло ? 'down' : 'zero'}>−{formatNum(f.вышло)}</span>
      </div>
    </div>
  )
}

export default function AgentsMainPage({ data, label }) {
  const { sort, onSort, apply } = useSort('лиды')
  const funnel = data?.funnel || []
  const flow = flowByStage(data?.flow || [])
  const daily = data?.daily || []
  const t = totals(daily)
  const prefixes = apply(byPrefix(daily))
  const всегоАгентов = funnel.reduce((a, s) => a + Number(s.агентов || 0), 0)
  const m = movesMatrix(data?.moves || [])

  return (
    <>
      <div className="portal-section-head">
        <h2 className="portal-section-title">Наполненность сети</h2>
        <p className="portal-section-note">
          Крупная цифра — сколько агентов стоит на этапе сейчас, она не
          зависит от выбранного периода. «+» и «−» под ней — сколько пришло
          и ушло за {label}. На последней ступени «−» всегда ноль: уходить
          с неё некуда.
        </p>
      </div>

      <div className="ag-funnel">
        {funnel.map(s => <Stage key={s.stage_id} s={s} flow={flow} />)}
      </div>

      <div className="rop-footer" style={{ marginTop: 6 }}>
        Всего в сети {formatNum(всегоАгентов)}{' '}
        {всегоАгентов % 10 === 1 && всегоАгентов % 100 !== 11 ? 'агент' : 'агентов'}.
        Служебные карточки «Агент не найден» и «Без агента» в воронку не
        входят: они лежат в тех же стадиях, что живые люди, и искажали бы
        картину.
      </div>

      {/* МАТРИЦА ПЕРЕХОДОВ ЗАКРЫВАЕТ ДЫРУ В ПЛИТКАХ. По «+» и «−» не видно
          направления: откат вниз выглядит как плюс на нижней ступени, то
          есть как рост. Здесь видно, кто куда двинулся на самом деле. */}
      {m.всего > 0 && (
        <>
          <div className="portal-section-head">
            <h2 className="portal-section-title">Куда двигались</h2>
            <p className="portal-section-note">
              Все переходы за {label}. Вверх — агент набрал клиентов, вниз —
              потерял. По плиткам выше этого не видно: откат выглядит там
              как «+» на нижней ступени.
            </p>
          </div>

          <div className="rop-metrics rop-metrics-calc">
            <div className="rop-metric ok">
              <div className="rop-metric-label">Выросли</div>
              <div className="rop-metric-value">{formatNum(m.вперёд)}</div>
              <div className="rop-metric-sub">переходов вверх</div>
            </div>
            <div className={`rop-metric ${m.доляНазад >= 20 ? 'bad' : 'warn'}`}>
              <div className="rop-metric-label">Откатились</div>
              <div className="rop-metric-value">{formatNum(m.назад)}</div>
              <div className="rop-metric-sub">{m.доляНазад}% всех переходов</div>
            </div>
          </div>

          <div className="table-wrap">
            <div className="table-scroll">
              <table className="table-compact rop-table">
                <thead>
                  <tr>
                    <th style={{ minWidth: 190 }}>Откуда</th>
                    <th style={{ minWidth: 190 }}>Куда</th>
                    <th className="portal-num">Переходов</th>
                  </tr>
                </thead>
                <tbody>
                  {m.list.map(r => (
                    <tr key={r.key}>
                      <td>{r.откуда}</td>
                      <td>
                        {r.куда}
                        {r.направление === 'назад' && <span className="ag-warn"> откат</span>}
                      </td>
                      <td className="portal-num">{formatNum(r.переходов)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      <div className="portal-section-head">
        <h2 className="portal-section-title">Приведено агентами</h2>
        <p className="portal-section-note">
          За {label}. Лид считается днём создания, квал — днём квалификации,
          встреча — днём встречи, сделка — днём оплаты. Та же логика, что во
          всём остальном приложении, поэтому цифры сходятся с дашбордом.
        </p>
      </div>

      <div className="rop-metrics">
        <div className="rop-metric big">
          <div className="rop-metric-label">Лиды</div>
          <div className="rop-metric-value">{formatNum(t.лиды)}</div>
        </div>
        <div className="rop-metric">
          <div className="rop-metric-label">Квалы</div>
          <div className="rop-metric-value">{formatNum(t.квалы)}</div>
          <div className="rop-metric-sub">{pct(t.квалы, t.лиды) ?? '—'}% от лидов</div>
        </div>
        <div className="rop-metric">
          <div className="rop-metric-label">Встречи</div>
          <div className="rop-metric-value">{formatNum(t.встречи)}</div>
          <div className="rop-metric-sub">{pct(t.встречи, t.квалы) ?? '—'}% от квалов</div>
        </div>
        <div className="rop-metric">
          <div className="rop-metric-label">Сделки</div>
          <div className="rop-metric-value">{formatNum(t.сделки)}</div>
          <div className="rop-metric-sub">{pct(t.сделки, t.встречи) ?? '—'}% от встреч</div>
        </div>
      </div>

      <div className="rop-metrics rop-metrics-calc">
        <div className="rop-metric">
          <div className="rop-metric-label">Revenue</div>
          <div className="rop-metric-value">{formatMoneyShort(t.выручка)}</div>
          <div className="rop-metric-sub">по оплаченным сделкам</div>
        </div>
        <div className="rop-metric">
          <div className="rop-metric-label">AOV</div>
          <div className="rop-metric-value">
            {aov(t) == null ? '—' : formatMoneyShort(aov(t))}
          </div>
          <div className="rop-metric-sub">выручка ÷ сделки</div>
        </div>
      </div>

      <div className="portal-section-head">
        <h2 className="portal-section-title">По префиксам источника</h2>
      </div>

      {prefixes.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-icon">📭</div>
          <h3>За {label} агенты ничего не привели</h3>
          <p>Либо период пустой, либо импорт ещё не отработал.</p>
        </div>
      ) : (
        <div className="table-wrap">
          <div className="table-scroll">
            <table className="table-compact rop-table">
              <thead>
                <tr>
                  <Th sort={sort} onSort={onSort} k="префикс" textual>Префикс</Th>
                  <Th sort={sort} onSort={onSort} k="лиды" className="portal-num">Лиды</Th>
                  <Th sort={sort} onSort={onSort} k="квалы" className="portal-num">Квалы</Th>
                  <Th sort={sort} onSort={onSort} k="встречи" className="portal-num">Встречи</Th>
                  <Th sort={sort} onSort={onSort} k="сделки" className="portal-num">Сделки</Th>
                  <Th sort={sort} onSort={onSort} k="выручка" className="portal-num">Revenue</Th>
                </tr>
              </thead>
              <tbody>
                {prefixes.map(p => (
                  <tr key={p.префикс}>
                    <td style={{ fontWeight: 600 }}>
                      {p.префикс}
                      {p.префикс !== 'agbfl' && <span className="ag-warn"> не свой канал</span>}
                    </td>
                    <td className="portal-num">{formatNum(p.лиды)}</td>
                    <td className="portal-num">{formatNum(p.квалы)}</td>
                    <td className="portal-num">{formatNum(p.встречи)}</td>
                    <td className="portal-num">{formatNum(p.сделки)}</td>
                    <td className="portal-num">{p.выручка ? formatMoneyShort(p.выручка) : '—'}</td>
                  </tr>
                ))}
                <tr className="rop-row-total">
                  <td style={{ fontWeight: 700 }}>Итого</td>
                  <td className="portal-num">{formatNum(t.лиды)}</td>
                  <td className="portal-num">{formatNum(t.квалы)}</td>
                  <td className="portal-num">{formatNum(t.встречи)}</td>
                  <td className="portal-num">{formatNum(t.сделки)}</td>
                  <td className="portal-num">{formatMoneyShort(t.выручка)}</td>
                </tr>
              </tbody>
            </table>
          </div>
        </div>
      )}

      {prefixes.length > 0 && (
        <div className="rop-footer">
          Агентский канал — <b>agbfl</b>. Остальное помечено «не свой канал»:
          лид засчитан, но выплата по нему не начислится, а агент об этом
          обычно не знает.
        </div>
      )}
    </>
  )
}
