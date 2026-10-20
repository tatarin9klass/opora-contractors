import React, { useEffect, useMemo, useState } from 'react'
import { todayISO } from '../lib/dateContext.js'
import {
  loadDeals, loadRopData, loadPortfolio, portfolioByManager, todoList, loadBalance,
  dealMoney, monthBounds, sumRows, planFor, byTeam, runRate, formatMoneyShort,
} from '../lib/rop.js'
import { formatNum, plural } from '../lib/helpers.js'

// ============================================================================
// «Сегодня» — первый экран кабинета, и единственный, который не отчитывается,
// а предлагает работу.
//
// ЗАЧЕМ ОН ПЕРВЫЙ. Отчёт отвечает на вопрос «как дела» — это вопрос
// руководителя направления, он задаёт его раз в неделю. Руководитель отдела
// открывает кабинет каждый день с другим вопросом: кого дёрнуть сейчас.
// Если на первом экране плитки с итогами, он читает их, кивает и закрывает
// — потому что из них не следует ни одного действия.
//
// КАЖДАЯ СТРОКА ЗДЕСЬ — ПОВОД К РАЗГОВОРУ, а не показатель. У неё есть
// счёт, деньги и список карточек, который раскрывается и проходится сверху
// вниз. Порядок — по деньгам: шесть зависших сделок на миллион важнее
// двадцати на сто тысяч.
//
// ЧЕГО ЗДЕСЬ НЕТ. Выбора периода: дела не бывают «за прошлую неделю».
// Метрик: они на соседней вкладке, и им там место.
// ============================================================================

function Money({ v }) {
  if (!v) return <span className="td-muted">—</span>
  return <span>{formatMoneyShort(v)}</span>
}

export default function RopTodayPage({ team = null, onGoTo }) {
  const [d, setD] = useState(null)
  const [flow, setFlow] = useState(null)
  const [pf, setPf] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(null)

  const month = useMemo(() => monthBounds(todayISO()), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError('')
    Promise.all([loadDeals(), loadRopData(month.from, month.to), loadPortfolio()])
      .then(([a, b, c]) => { if (!cancelled) { setD(a); setFlow(b); setPf(c) } })
      .catch(e => { if (!cancelled) setError(String(e?.message || e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [month.from, month.to])

  const deals = useMemo(() => byTeam(d?.deals || [], team), [d, team])
  const пф = useMemo(() => portfolioByManager(byTeam(pf?.portfolio || [], team)), [pf, team])
  const ожидаемо = useMemo(() => пф.reduce((a, m) => a + m.ожидаемо, 0), [пф])

  const планОкс = flow ? planFor(flow.plans || [], month.from, 'оксвсего', null, team) : null
  const фактОкс = flow ? sumRows(byTeam(flow.daily || [], team)).окс_всего : 0
  const остаток = планОкс == null ? null : Math.max(0, планОкс - фактОкс)
  const темп = runRate(фактОкс, month.from, month.to)

  const дела = useMemo(
    () => todoList(deals, { остатокПлана: остаток, ожидаемо }),
    [deals, остаток, ожидаемо],
  )
  const нагрузка = useMemo(() => loadBalance(deals), [deals])

  if (loading && !d) return <div className="loading">Загрузка...</div>

  const деньМесяца = new Date().getDate()
  const всегоДней = Number(month.to.slice(8))

  return (
    <div className={loading ? 'portal-fading' : ''}>
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

      {/* Одна строка состояния вместо четырёх плиток: на экране дел метрика
          нужна ровно в том объёме, в каком она объясняет срочность. */}
      <div className="rop-status">
        <div className="rop-status-main">
          <b>{formatNum(фактОкс)}</b> из {планОкс == null ? '—' : formatNum(планОкс)}
          {' '}{plural(фактОкс, 'передача', 'передачи', 'передач')} за месяц
        </div>
        <div className="rop-status-sub">
          день {деньМесяца} из {всегоДней}
          {планОкс != null && темп != null && (
            <> · при текущем темпе выйдет <b>{formatNum(темп)}</b></>
          )}
          {остаток != null && остаток > 0 && (
            <> · осталось <b>{formatNum(остаток)}</b>, портфель даст{' '}
              <b>{Math.round(ожидаемо)}</b></>
          )}
        </div>
      </div>

      <div className="portal-section-head">
        <h2 className="portal-section-title">Чем заняться сегодня</h2>
        <p className="portal-section-note">
          Сверху то, где больше денег. Щёлкните по строке — откроется список
          сделок; по нему можно идти сверху вниз.
        </p>
      </div>

      {дела.length === 0 && (
        <div className="empty-state">
          <div className="empty-state-icon">✅</div>
          <h3>Ничего не горит</h3>
          <p>Залежавшихся сделок нет, встречи обработаны, приёмка идёт в срок.</p>
        </div>
      )}

      <div className="rop-todo">
        {дела.map(it => (
          <div key={it.id} className={`rop-todo-item ${it.tone}`}>
            <div className="rop-todo-head"
                 onClick={() => !it.noDeals && setOpen(open === it.id ? null : it.id)}
                 style={{ cursor: it.noDeals ? 'default' : 'pointer' }}>
              <div className="rop-todo-n">{formatNum(it.count)}</div>
              <div className="rop-todo-text">
                <div className="rop-todo-title">
                  {!it.noDeals && (open === it.id ? '▾ ' : '▸ ')}{it.title}
                </div>
                <div className="rop-todo-hint">{it.hint}</div>
              </div>
              <div className="rop-todo-money"><Money v={it.money} /></div>
            </div>

            {open === it.id && (
              <div className="rop-stuck">
                {[...it.deals]
                  .sort((a, b) => dealMoney(b) - dealMoney(a) || b.дней_без_движения - a.дней_без_движения)
                  .slice(0, 50)
                  .map(x => (
                    <div key={x.deal_id} className="rop-stuck-row">
                      <span className="rop-stuck-days">{x.дней_без_движения} дн.</span>
                      <span className="rop-stuck-stage">{x.менеджер}</span>
                      <span className="rop-stuck-title">{x.title || `сделка ${x.deal_id}`}</span>
                      <span className="rop-stuck-sum">
                        {dealMoney(x) ? formatMoneyShort(dealMoney(x)) : '—'}
                      </span>
                    </div>
                  ))}
                {it.deals.length > 50 && (
                  <div className="portal-muted" style={{ marginTop: 6 }}>
                    показаны пятьдесят самых крупных из {formatNum(it.deals.length)}
                  </div>
                )}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* --- Нагрузка ------------------------------------------------------ */}
      {нагрузка.list.length > 0 && (
        <>
          <div className="portal-section-head">
            <h2 className="portal-section-title">Нагрузка</h2>
            <p className="portal-section-note">
              Сколько сделок в работе у каждого. Перекос заметен не по таблице,
              а по разнице с соседом — поэтому он назван словами, а не оставлен
              читателю.
            </p>
          </div>

          {нагрузка.перекос && (
            <div className="rop-note warn">
              У <b>{нагрузка.перекос.max.менеджер}</b> {formatNum(нагрузка.перекос.max.сделок)}{' '}
              {plural(нагрузка.перекос.max.сделок, 'сделка', 'сделки', 'сделок')} в работе, у{' '}
              <b>{нагрузка.перекос.min.менеджер}</b> — {formatNum(нагрузка.перекос.min.сделок)}.
              {' '}Разница больше полутора раз: стоит либо перераспределить, либо
              понять, почему поток идёт неравномерно.
            </div>
          )}

          <div className="rop-load">
            {нагрузка.list.map(m => {
              const доля = нагрузка.list[0].сделок ? m.сделок / нагрузка.list[0].сделок : 0
              const зал = m.сделок ? m.залежалось / m.сделок : 0
              return (
                <div key={m.менеджер} className="rop-load-row">
                  <span className="rop-load-name">{m.менеджер}</span>
                  <span className="rop-load-bar">
                    <span className="rop-load-fill" style={{ width: `${Math.round(100 * доля)}%` }} />
                    <span className="rop-load-stale"
                          style={{ width: `${Math.round(100 * доля * зал)}%` }} />
                  </span>
                  <span className="rop-load-n">{formatNum(m.сделок)}</span>
                  <span className="rop-load-money">{formatMoneyShort(m.деньги)}</span>
                </div>
              )
            })}
          </div>
          <div className="rop-footer">
            Красной частью полосы показаны залежавшиеся сделки — та часть
            портфеля, которая не движется. Деньги считаются по товарным
            позициям, а где их нет — по сумме в карточке.
          </div>
        </>
      )}
    </div>
  )
}
