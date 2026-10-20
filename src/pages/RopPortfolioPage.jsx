import React, { useEffect, useMemo, useState } from 'react'
import { todayISO } from '../lib/dateContext.js'
import {
  loadPortfolio, loadRopData, portfolioByManager, PORTFOLIO_STAGES,
  monthBounds, sumRows, planFor, byTeam, formatMoneyShort,
} from '../lib/rop.js'
import { formatNum, plural } from '../lib/helpers.js'

// ============================================================================
// Портфель — что у менеджера на руках прямо сейчас.
//
// ЧЕМ ОН ОТЛИЧАЕТСЯ ОТ ОСТАЛЬНЫХ ЭКРАНОВ. Дашборд и менеджеры показывают
// поток: что случилось за период. Портфель показывает запас: что лежит
// сегодня. Поток отвечает на «как сработали», запас — на «есть ли чем
// работать дальше», и по первому нельзя судить о втором. Месяц может быть
// отличным, а портфель пустым — и тогда следующий месяц уже предрешён.
//
// ПОЭТОМУ ЗДЕСЬ НЕТ ВЫБОРА ПЕРИОДА. Запас не бывает «за прошлую неделю»,
// он бывает только сейчас. Единственное место, где период появляется, —
// остаток плана: его надо с чем-то сравнивать, и берётся текущий месяц.
//
// ВОЗРАСТ СЧИТАЕТСЯ ОТ ПОСЛЕДНЕГО ДВИЖЕНИЯ, а порог «залежалась» у каждого
// этапа свой и взят из истории: срок, за который с этапа уходят восемь
// сделок из десяти. На приёмке в ОКС это несколько дней, на ИКП — недели.
// ============================================================================

function Card({ label, value, sub, tone }) {
  return (
    <div className={`rop-metric ${tone || ''}`}>
      <div className="rop-metric-label">{label}</div>
      <div className="rop-metric-value">{value}</div>
      {sub && <div className="rop-metric-sub">{sub}</div>}
    </div>
  )
}

export default function RopPortfolioPage({ team = null }) {
  const [data, setData] = useState(null)
  const [flow, setFlow] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(null)

  const month = useMemo(() => monthBounds(todayISO()), [])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError('')
    Promise.all([loadPortfolio(), loadRopData(month.from, month.to)])
      .then(([p, f]) => { if (!cancelled) { setData(p); setFlow(f) } })
      .catch(e => { if (!cancelled) setError(String(e?.message || e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [month.from, month.to])

  const rows = useMemo(() => byTeam(data?.portfolio || [], team), [data, team])
  const stuck = useMemo(() => byTeam(data?.stuck || [], team), [data, team])
  const managers = useMemo(() => portfolioByManager(rows), [rows])

  const итого = useMemo(() => managers.reduce((a, m) => ({
    всего: a.всего + m.всего,
    приёмка: a.приёмка + m.приёмка,
    залежалось: a.залежалось + m.залежалось,
    ожидаемо: a.ожидаемо + m.ожидаемо,
    без_суммы: a.без_суммы + m.без_суммы,
    чек_сумма: a.чек_сумма + m.чек_сумма,
    чек_сделок: a.чек_сделок + m.чек_сделок,
  }), { всего: 0, приёмка: 0, залежалось: 0, ожидаемо: 0, без_суммы: 0, чек_сумма: 0, чек_сделок: 0 }), [managers])

  // Остаток плана: сколько передач ещё нужно до конца месяца. Берётся из
  // того же места, что и на дашборде, — плана на отдел по метрике «оксвсего».
  const планОкс = flow ? planFor(flow.plans || [], month.from, 'оксвсего', null, team) : null
  const фактОкс = flow ? sumRows(byTeam(flow.daily || [], team)).окс_всего : 0
  const остаток = планОкс == null ? null : Math.max(0, планОкс - фактОкс)
  const покрытие = остаток ? Math.round((100 * итого.ожидаемо) / остаток) : null

  if (loading && !data) return <div className="loading">Загрузка...</div>

  return (
    <div className={loading ? 'portal-fading' : ''}>
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

      <div className="portal-section-head">
        <h2 className="portal-section-title">Что в работе сейчас</h2>
        <p className="portal-section-note">
          Снимок на сегодня, без выбора периода: запас не бывает «за прошлую
          неделю». Залежавшейся считается сделка, простоявшая дольше, чем её
          этап держит восемь сделок из десяти, — порог взят из истории
          переходов, а не назначен.
        </p>
      </div>

      <div className="rop-metrics">
        <Card label="Сделок в работе" value={formatNum(итого.всего)}
              sub={`у ${managers.length} ${plural(managers.length, 'менеджера', 'менеджеров', 'менеджеров')}`} />
        <Card label="Залежалось" value={formatNum(итого.залежалось)}
              tone={итого.всего && итого.залежалось / итого.всего > 0.3 ? 'bad' : итого.залежалось ? 'warn' : ''}
              sub={итого.всего ? `${Math.round((100 * итого.залежалось) / итого.всего)}% портфеля` : null} />
        <Card label="На приёмке в ОКС" value={formatNum(итого.приёмка)}
              sub="ждут решения, до трёх рабочих дней" />
        <Card
          label="Ожидаемо передач" value={итого.ожидаемо ? Math.round(итого.ожидаемо) : '—'}
          sub={итого.ожидаемо
            ? 'по историческим шансам этапов'
            : 'истории пока мало для расчёта'}
        />
      </div>

      {планОкс != null && (
        <div className={`rop-note ${покрытие != null && покрытие < 100 ? 'warn' : ''}`}>
          {остаток === 0
            ? `План месяца уже выполнен: ${formatNum(фактОкс)} из ${formatNum(планОкс)}. Портфель работает на следующий месяц.`
            : <>
                До плана осталось <b>{formatNum(остаток)}</b> {plural(остаток, 'передача', 'передачи', 'передач')}
                {' '}({formatNum(фактОкс)} из {formatNum(планОкс)}). Текущий портфель при обычных шансах этапов
                {' '}даст <b>{Math.round(итого.ожидаемо)}</b> — это{' '}
                <b>{покрытие == null ? '—' : покрытие + '%'}</b> остатка.
                {покрытие != null && покрытие < 100 &&
                  ' Материала не хватает: либо нужны новые встречи, либо двигать то, что стоит.'}
              </>}
        </div>
      )}

      {итого.без_суммы > 0 && (
        <div className="rop-alert">
          <b>{formatNum(итого.без_суммы)}</b> {plural(итого.без_суммы, 'сделка', 'сделки', 'сделок')} в портфеле
          {' '}без суммы — ни товарных позиций, ни суммы в карточке. Денежный потенциал
          {' '}портфеля по ним посчитать нельзя, поэтому он и не считается: подставить средний
          {' '}чек значило бы нарисовать уверенную цифру там, где её нет.
        </div>
      )}

      <div className="table-wrap" style={{ marginTop: 14 }}>
        <div className="table-toolbar">
          <strong style={{ fontSize: 13 }}>Портфель по менеджерам</strong>
          <span className="portal-muted">щёлкните по строке — покажутся залежавшиеся сделки</span>
        </div>
        <div className="table-scroll">
          <table className="table-compact rop-table">
            <thead>
              <tr>
                <th>Менеджер</th>
                <th>В работе</th>
                {PORTFOLIO_STAGES.map(s => <th key={s.id}>{s.label}</th>)}
                <th>На приёмке</th>
                <th>Залежалось</th>
                <th>Ожидаемо передач</th>
                <th>Средний чек портфеля</th>
              </tr>
            </thead>
            <tbody>
              {managers.map(m => {
                const доля = m.всего ? m.залежалось / m.всего : 0
                const мои = stuck.filter(s => s.менеджер === m.менеджер)
                return (
                  <React.Fragment key={m.менеджер}>
                    <tr onClick={() => setOpen(open === m.менеджер ? null : m.менеджер)}
                        style={{ cursor: 'pointer' }}>
                      <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {open === m.менеджер ? '▾ ' : '▸ '}{m.менеджер}
                        {!m.работает && <span className="rop-left">уволен</span>}
                      </td>
                      <td className="portal-num">{formatNum(m.всего)}</td>
                      {PORTFOLIO_STAGES.map(s => (
                        <td key={s.id} className="portal-num">
                          {m.этапы[s.id] ? formatNum(m.этапы[s.id]) : <span className="td-muted">—</span>}
                        </td>
                      ))}
                      <td className="portal-num">
                        {m.приёмка ? formatNum(m.приёмка) : <span className="td-muted">—</span>}
                      </td>
                      <td className="portal-num">
                        <span className={доля > 0.4 ? 'rop-conv bad' : доля > 0.2 ? 'rop-conv warn' : 'rop-conv'}>
                          {formatNum(m.залежалось)}
                        </span>
                        {m.всего > 0 && <span className="rop-plan"> {Math.round(100 * доля)}%</span>}
                      </td>
                      <td className="portal-num">
                        {m.ожидаемо ? Math.round(m.ожидаемо) : <span className="td-muted">—</span>}
                      </td>
                      <td className="portal-num">
                        {m.чек_сделок
                          ? formatMoneyShort(m.чек_сумма / m.чек_сделок)
                          : <span className="td-muted">—</span>}
                      </td>
                    </tr>

                    {open === m.менеджер && (
                      <tr className="rop-subrow">
                        <td colSpan={PORTFOLIO_STAGES.length + 6}>
                          {мои.length === 0
                            ? <span className="portal-muted">Залежавшихся сделок нет — весь портфель в движении.</span>
                            : (
                              <div className="rop-stuck">
                                {мои.slice(0, 40).map(s => (
                                  <div key={s.deal_id} className="rop-stuck-row">
                                    <span className="rop-stuck-days">{s.дней_без_движения} дн.</span>
                                    <span className="rop-stuck-stage">{s.этап}</span>
                                    <span className="rop-stuck-title">{s.title || `сделка ${s.deal_id}`}</span>
                                    <span className="rop-stuck-sum">
                                      {s.чек ? formatMoneyShort(s.чек) : '—'}
                                    </span>
                                  </div>
                                ))}
                                {мои.length > 40 && (
                                  <div className="portal-muted" style={{ marginTop: 6 }}>
                                    показаны сорок самых старых из {formatNum(мои.length)}
                                  </div>
                                )}
                              </div>
                            )}
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      {(data?.outside || []).length > 0 && (
        <div className="rop-alert" style={{ marginTop: 12 }}>
          <b>Вне состава отделов:</b>{' '}
          {data.outside.map(o => `${o.кто} — ${o.сделок}`).join(' · ')}.
          {' '}Эти сделки в показатели не входят. Если среди фамилий появился живой
          {' '}менеджер, его нужно завести в составе отдела — иначе весь его портфель
          {' '}останется невидимым.
        </div>
      )}

      <div className="rop-footer">
        «Ожидаемо передач» — это сумма по этапам: сколько сделок стоит на этапе,
        умноженное на долю тех, кто с него доходил до ОКС раньше. Считается только
        по этапам, где таких случаев набралось достаточно; где истории мало, стоит
        прочерк, и это честнее придуманного числа. Средний чек портфеля берётся из
        товарных позиций — там, где они заполнены.
      </div>
    </div>
  )
}
