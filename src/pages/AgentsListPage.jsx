import React, { useState } from 'react'
import { byAgent, totals, aov, pct } from '../lib/agents.js'
import { useSort, Th } from '../lib/sortable.jsx'
import { formatNum } from '../lib/helpers.js'
import { formatMoneyShort } from '../lib/rop.js'

// ============================================================================
// «Агенты» — то же, что вкладка подрядчиков, только подрядчик здесь человек.
//
// СТОИМОСТИ ЗДЕСЬ НЕТ И НЕ БУДЕТ. У подрядчика есть расход, и потому есть
// цена лида. Агенту платят с результата, а не за трафик: делить нечего, и
// колонка «стоимость заявки» была бы выдуманной.
//
// СТРОКА РАСКРЫВАЕТСЯ В ПРЕФИКСЫ, и ради этого вкладка и сделана. Общая
// цифра «сто лидов» ничего не говорит о том, что восемьдесят пришли своим
// каналом, а двадцать — чужим. Второе значит, что агент передаёт лиды
// неправильно и теряет на этом выплату, причём молча.
// ============================================================================

export default function AgentsListPage({ data, label }) {
  const [open, setOpen] = useState(null)
  const { sort, onSort, apply } = useSort('лиды')
  const daily = data?.daily || []
  const люди = apply(byAgent(daily))
  const t = totals(daily)

  if (!люди.length) {
    return (
      <div className="empty-state">
        <div className="empty-state-icon">📭</div>
        <h3>За {label} агенты ничего не привели</h3>
        <p>Либо период пустой, либо импорт ещё не отработал.</p>
      </div>
    )
  }

  return (
    <>
      <div className="portal-section-head">
        <h2 className="portal-section-title">Агенты</h2>
        <p className="portal-section-note">
          За {label}, по убыванию лидов. Щёлкните по строке — развернётся
          разбивка по префиксам: через какие каналы человек передавал.
          «Мимо» — доля лидов, пришедших не через agbfl. Любой заголовок
          столбца сортирует таблицу.
        </p>
      </div>

      <div className="table-wrap">
        <div className="table-scroll">
          <table className="table-compact rop-table">
            <thead>
              <tr>
                <Th sort={sort} onSort={onSort} k="агент" textual>Агент</Th>
                <Th sort={sort} onSort={onSort} k="лиды" className="portal-num">Лиды</Th>
                <Th sort={sort} onSort={onSort} k="квалы" className="portal-num">Квалы</Th>
                <Th sort={sort} onSort={onSort} k="к_квал" className="portal-num">лид→квал</Th>
                <Th sort={sort} onSort={onSort} k="встречи" className="portal-num">Встречи</Th>
                <Th sort={sort} onSort={onSort} k="к_встреча" className="portal-num">квал→встреча</Th>
                <Th sort={sort} onSort={onSort} k="сделки" className="portal-num">Сделки</Th>
                <Th sort={sort} onSort={onSort} k="к_сделка" className="portal-num">встреча→сделка</Th>
                <Th sort={sort} onSort={onSort} k="выручка" className="portal-num">Revenue</Th>
                <Th sort={sort} onSort={onSort} k="aov" className="portal-num">AOV</Th>
                <Th sort={sort} onSort={onSort} k="мимо" className="portal-num">Мимо</Th>
              </tr>
            </thead>
            <tbody>
              {люди.map(a => {
                const раскрыт = open === a.agent_id
                return (
                  <React.Fragment key={a.agent_id}>
                    <tr onClick={() => setOpen(раскрыт ? null : a.agent_id)}
                        style={{ cursor: 'pointer' }}>
                      <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {раскрыт ? '▾ ' : '▸ '}{a.агент}
                        {a.вид === 'не найден' && <span className="ag-warn"> не опознан</span>}
                      </td>
                      <td className="portal-num">{formatNum(a.лиды)}</td>
                      <td className="portal-num">{formatNum(a.квалы)}</td>
                      <td className="portal-num">{pct(a.квалы, a.лиды) ?? '—'}%</td>
                      <td className="portal-num">{formatNum(a.встречи)}</td>
                      <td className="portal-num">{pct(a.встречи, a.квалы) ?? '—'}%</td>
                      <td className="portal-num">{formatNum(a.сделки)}</td>
                      <td className="portal-num">{pct(a.сделки, a.встречи) ?? '—'}%</td>
                      <td className="portal-num">{a.выручка ? formatMoneyShort(a.выручка) : '—'}</td>
                      <td className="portal-num">{aov(a) == null ? '—' : formatMoneyShort(aov(a))}</td>
                      <td className="portal-num">
                        {a.мимо
                          ? <span className={a.мимо >= 30 ? 'rop-conv bad' : 'rop-conv'}>{a.мимо}%</span>
                          : <span className="td-muted">—</span>}
                      </td>
                    </tr>
                    {раскрыт && a.префиксы.map(p => (
                      <tr key={a.agent_id + p.префикс} className="rop-subrow">
                        <td style={{ paddingLeft: 26, color: 'var(--text-muted)' }}>
                          {p.префикс}
                          {p.префикс !== 'agbfl' && <span className="ag-warn"> не свой канал</span>}
                        </td>
                        <td className="portal-num">{formatNum(p.лиды)}</td>
                        <td className="portal-num">{formatNum(p.квалы)}</td>
                        <td className="portal-num">{pct(p.квалы, p.лиды) ?? '—'}%</td>
                        <td className="portal-num">{formatNum(p.встречи)}</td>
                        <td className="portal-num">{pct(p.встречи, p.квалы) ?? '—'}%</td>
                        <td className="portal-num">{formatNum(p.сделки)}</td>
                        <td className="portal-num">{pct(p.сделки, p.встречи) ?? '—'}%</td>
                        <td className="portal-num">{p.выручка ? formatMoneyShort(p.выручка) : '—'}</td>
                        <td className="portal-num">{aov(p) == null ? '—' : formatMoneyShort(aov(p))}</td>
                        <td />
                      </tr>
                    ))}
                  </React.Fragment>
                )
              })}
              <tr className="rop-row-total">
                <td style={{ fontWeight: 700 }}>Итого · {formatNum(люди.length)}</td>
                <td className="portal-num">{formatNum(t.лиды)}</td>
                <td className="portal-num">{formatNum(t.квалы)}</td>
                <td className="portal-num">{pct(t.квалы, t.лиды) ?? '—'}%</td>
                <td className="portal-num">{formatNum(t.встречи)}</td>
                <td className="portal-num">{pct(t.встречи, t.квалы) ?? '—'}%</td>
                <td className="portal-num">{formatNum(t.сделки)}</td>
                <td className="portal-num">{pct(t.сделки, t.встречи) ?? '—'}%</td>
                <td className="portal-num">{formatMoneyShort(t.выручка)}</td>
                <td className="portal-num">{aov(t) == null ? '—' : formatMoneyShort(aov(t))}</td>
                <td />
              </tr>
            </tbody>
          </table>
        </div>
      </div>

      <div className="rop-footer">
        Стоимости заявки и стоимости этапов здесь нет намеренно: агенту
        платят с результата, а не за трафик, и делить расход не на что.
        «Агент не опознан» — это лиды с префиксом agbfl, у которых поле «СП
        агенты» заполнено заглушкой: выплата по ним положена, но получателя
        надо найти руками.
      </div>
    </>
  )
}
