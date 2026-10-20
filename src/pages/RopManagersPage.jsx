import React, { useEffect, useMemo, useState } from 'react'
import { todayISO } from '../lib/dateContext.js'
import {
  loadRopData, loadPortfolio, portfolioByManager, periodBounds, recentMonths,
  planFor, planStatus, paceTarget, byTeam, formatMoneyShort, GROUPS,
} from '../lib/rop.js'
import { formatNum } from '../lib/helpers.js'

// ============================================================================
// Показатели по менеджерам отдела.
//
// КОНВЕРСИИ СЧИТАЮТСЯ ТОЛЬКО ТАМ, ГДЕ ЭТАПЫ ПРОХОДИТ ОДНА СДЕЛКА:
// встреча → ИКП → договор без оплаты → полная/частичная оплата. Это честные
// переходы внутри карточки, и история стадий позволяет их считать.
//
// «Передано в ОКС» стоит отдельным счётчиком без конверсии, и это не
// упущение: передача оформляется новой карточкой, у которой нет истории
// встречи. Делить передачи на встречи значило бы делить одни сделки на
// другие — на рекомендациях такое отношение уже дало 106%.
//
// РАЗВЁРТКА НА МАРКЕТИНГ И РЕКОМЕНДАЦИИ открывается по клику на строке. У
// рекомендаций доходимость втрое выше, и сравнивать менеджеров, не глядя на
// состав их потока, — значит сравнивать разный материал.
// ============================================================================

const MODES = [
  { id: 'month', label: 'Месяц' },
  { id: 'week', label: 'Неделя' },
  { id: 'range', label: 'Период' },
]

function pct(a, b) {
  if (!b) return null
  return Math.round((1000 * a) / b) / 10
}

// ЦВЕТ КОНВЕРСИИ — ЭТО СРАВНЕНИЕ С ОТДЕЛОМ, А НЕ С АБСОЛЮТНОЙ НОРМОЙ.
// Нормы «хорошая конверсия встреча → ИКП» у нас нет, и выдумывать её
// порогом в пятьдесят процентов нельзя: получится, что экран оценивает
// людей по числу, взятому из воздуха. Отдел же — честная база сравнения:
// он работает с тем же потоком в тот же месяц.
function tone(value, base, inverse = false) {
  if (value == null || base == null || !base) return ''
  const r = value / base
  if (inverse) return r <= 0.9 ? 'ok' : r >= 1.25 ? 'bad' : ''
  return r >= 1.1 ? 'ok' : r <= 0.75 ? 'bad' : ''
}

function Conv({ value, base, inverse }) {
  if (value == null) return <span className="td-muted">—</span>
  // Больше ста процентов — не ошибка расчёта: сделка могла попасть на этап,
  // минуя предыдущий, и в знаменателе её нет, а в числителе есть. Цифру
  // прячем не мы, а подсказка объясняет, откуда она.
  const over = value > 100
  return (
    <span
      className={`rop-conv ${tone(value, base, inverse)} ${over ? 'over' : ''}`}
      title={over ? 'Больше 100%: часть сделок попала на этот этап, минуя предыдущий' : undefined}
    >
      {formatNum(value)}%
    </span>
  )
}

export default function RopManagersPage({ team = null }) {
  const [mode, setMode] = useState('month')
  const [anchor, setAnchor] = useState(todayISO())
  const [from, setFrom] = useState(todayISO())
  const [to, setTo] = useState(todayISO())
  const [data, setData] = useState(null)
  const [pf, setPf] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [openRow, setOpenRow] = useState(null)

  const months = useMemo(() => recentMonths(12), [])
  const bounds = useMemo(() => periodBounds(mode, anchor, from, to), [mode, anchor, from, to])

  useEffect(() => {
    let cancelled = false
    setLoading(true); setError('')
    loadRopData(bounds.from, bounds.to)
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(String(e?.message || e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [bounds.from, bounds.to])

  // Портфель грузится отдельно и не зависит от периода: это снимок на
  // сегодня. Он здесь затем, что по одному потоку нельзя судить о человеке —
  // месяц мог быть отличным при пустом портфеле, и тогда следующий уже
  // предрешён.
  useEffect(() => {
    let cancelled = false
    loadPortfolio()
      .then(d => { if (!cancelled) setPf(d) })
      .catch(() => { if (!cancelled) setPf({ portfolio: [] }) })
    return () => { cancelled = true }
  }, [])

  const запас = useMemo(() => {
    const m = new Map()
    for (const r of portfolioByManager(byTeam(pf?.portfolio || [], team))) m.set(r.менеджер, r)
    return m
  }, [pf, team])

  // Свод по менеджеру, и отдельно по каждой группе источника — для развёртки.
  // Заодно складывается отдел целиком: он нужен как база сравнения, по
  // которой красится конверсия.
  const dept = useMemo(() => {
    const t = { всего: blank(), группы: new Map() }
    for (const r of byTeam(data?.byManager || [], team)) {
      add(t.всего, r)
      if (!t.группы.has(r.группа)) t.группы.set(r.группа, blank())
      add(t.группы.get(r.группа), r)
    }
    return t
  }, [data, team])

  const byManager = useMemo(() => {
    const rows = byTeam(data?.byManager || [], team)
    const m = new Map()
    for (const r of rows) {
      const key = r.менеджер
      if (!m.has(key)) {
        m.set(key, {
          менеджер: key, sort: r.sort_order ?? 100,
          всего: blank(), группы: new Map(),
        })
      }
      const cur = m.get(key)
      add(cur.всего, r)
      if (!cur.группы.has(r.группа)) cur.группы.set(r.группа, blank())
      add(cur.группы.get(r.группа), r)
    }
    return [...m.values()].sort((a, b) => a.sort - b.sort)
  }, [data, team])

  const plans = data?.plans || []

  if (loading && !data) return <div className="loading">Загрузка...</div>

  return (
    <div className={loading ? 'portal-fading' : ''}>
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

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
                     min="2026-09-01" max={todayISO()} onChange={e => setFrom(e.target.value)} />
              <span className="portal-muted">—</span>
              <input className="form-input portal-date" type="date" value={to}
                     min="2026-09-01" max={todayISO()} onChange={e => setTo(e.target.value)} />
            </>
          )}
          <span className="portal-period-label">
            {bounds.from.split('-').reverse().join('.')} — {bounds.to.split('-').reverse().join('.')}
          </span>
        </div>
      </div>

      <div className="table-wrap">
        <div className="table-toolbar">
          <strong style={{ fontSize: 13 }}>Показатели менеджеров</strong>
          <span className="portal-muted">
            щёлкните по строке — развернётся маркетинг и рекомендации
          </span>
        </div>
        <div className="table-scroll">
          <table className="table-compact rop-table">
            <thead>
              <tr>
                <th>Менеджер</th>
                <th>Встречи</th>
                <th>Брак</th>
                <th>в брак</th>
                <th>ИКП</th>
                <th>встреча→ИКП</th>
                <th>Договор б/о</th>
                <th>ИКП→договор</th>
                <th>Оплата</th>
                <th>договор→оплата</th>
                <th>В ОКС</th>
                <th>Чек БФЛ</th>
                <th className="rop-sep">В работе</th>
                <th>Залежалось</th>
              </tr>
            </thead>
            <tbody>
              {byManager.map(m => {
                const t = m.всего
                const d = dept.всего
                const planВстречи = planFor(plans, bounds.from, 'встречи', m.менеджер, team)
                const planОкс = planFor(plans, bounds.from, 'оксвсего', m.менеджер, team)
                return (
                  <React.Fragment key={m.менеджер}>
                    <tr onClick={() => setOpenRow(openRow === m.менеджер ? null : m.менеджер)}
                        style={{ cursor: 'pointer' }}>
                      <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {openRow === m.менеджер ? '▾ ' : '▸ '}{m.менеджер}
                      </td>
                      <td className="portal-num">
                        {formatNum(t.встречи)}
                        {planВстречи != null && (
                          <span className={`rop-plan ${planStatus(t.встречи, paceTarget(planВстречи, bounds.from, bounds.to))}`}>
                            /{formatNum(planВстречи)}
                          </span>
                        )}
                      </td>
                      <td className="portal-num">{formatNum(t.брак)}</td>
                      <td className="portal-num"><Conv value={pct(t.брак, t.встречи)} base={pct(d.брак, d.встречи)} inverse /></td>
                      <td className="portal-num">{formatNum(t.икп)}</td>
                      <td className="portal-num"><Conv value={pct(t.икп, t.встречи)} base={pct(d.икп, d.встречи)} /></td>
                      <td className="portal-num">{formatNum(t.договор_без_оплаты)}</td>
                      <td className="portal-num"><Conv value={pct(t.договор_без_оплаты, t.икп)} base={pct(d.договор_без_оплаты, d.икп)} /></td>
                      <td className="portal-num">{formatNum(t.оплата)}</td>
                      <td className="portal-num"><Conv value={pct(t.оплата, t.договор_без_оплаты)} base={pct(d.оплата, d.договор_без_оплаты)} /></td>
                      <td className="portal-num">
                        {formatNum(t.окс_всего)}
                        {planОкс != null && (
                          <span className={`rop-plan ${planStatus(t.окс_всего, paceTarget(planОкс, bounds.from, bounds.to))}`}>
                            /{formatNum(planОкс)}
                          </span>
                        )}
                      </td>
                      <td className="portal-num">
                        {t.чек_бфл_сделок
                          ? formatMoneyShort(t.чек_бфл_сумма / t.чек_бфл_сделок)
                          : <span className="td-muted">—</span>}
                      </td>
                      {(() => {
                        const z = запас.get(m.менеджер)
                        const всего = z ? z.всего + z.приёмка : 0
                        const доля = z && z.всего ? z.залежалось / z.всего : 0
                        return (
                          <>
                            <td className="portal-num rop-sep">
                              {всего ? formatNum(всего) : <span className="td-muted">—</span>}
                            </td>
                            <td className="portal-num">
                              {z && z.залежалось
                                ? <span className={доля > 0.4 ? 'rop-conv bad' : доля > 0.2 ? 'rop-conv warn' : 'rop-conv'}>
                                    {formatNum(z.залежалось)}
                                  </span>
                                : <span className="td-muted">—</span>}
                            </td>
                          </>
                        )
                      })()}
                    </tr>

                    {openRow === m.менеджер && GROUPS.map(g => {
                      const s = m.группы.get(g.id)
                      if (!s) return null
                      // Группа сравнивается со своей же группой по отделу:
                      // рекомендации доходят втрое лучше маркетинга, и
                      // мерить их общей средней значило бы хвалить всех,
                      // у кого рекомендаций просто больше.
                      const b = dept.группы.get(g.id) || blank()
                      return (
                        <tr key={g.id} className="rop-subrow">
                          <td style={{ paddingLeft: 26 }}>
                            <span className={`rop-dot ${g.id === 'маркетинг' ? 'mk' : g.id === 'рекомендации' ? 'rec' : 'oth'}`} />
                            {g.label}
                          </td>
                          <td className="portal-num">{formatNum(s.встречи)}</td>
                          <td className="portal-num">{formatNum(s.брак)}</td>
                          <td className="portal-num"><Conv value={pct(s.брак, s.встречи)} base={pct(b.брак, b.встречи)} inverse /></td>
                          <td className="portal-num">{formatNum(s.икп)}</td>
                          <td className="portal-num"><Conv value={pct(s.икп, s.встречи)} base={pct(b.икп, b.встречи)} /></td>
                          <td className="portal-num">{formatNum(s.договор_без_оплаты)}</td>
                          <td className="portal-num"><Conv value={pct(s.договор_без_оплаты, s.икп)} base={pct(b.договор_без_оплаты, b.икп)} /></td>
                          <td className="portal-num">{formatNum(s.оплата)}</td>
                          <td className="portal-num"><Conv value={pct(s.оплата, s.договор_без_оплаты)} base={pct(b.оплата, b.договор_без_оплаты)} /></td>
                          <td className="portal-num">{formatNum(s.окс_всего)}</td>
                          <td className="portal-num">
                            {s.чек_бфл_сделок
                              ? formatMoneyShort(s.чек_бфл_сумма / s.чек_бфл_сделок)
                              : <span className="td-muted">—</span>}
                          </td>
                          <td className="rop-sep" />
                          <td />
                        </tr>
                      )
                    })}
                  </React.Fragment>
                )
              })}
            </tbody>
          </table>
        </div>
      </div>

      <div className="rop-footer">
        Конверсии считаются внутри одной сделки по истории переходов — значит
        сделка попадает в числитель каждого этапа, через который прошла, а не
        только того, где стоит сейчас. Сделка могла попасть на этап, минуя
        предыдущий, поэтому конверсия иногда больше ста процентов — такие
        числа помечены. Цвет конверсии — это сравнение с отделом за тот же
        период, а не с абсолютной нормой: нормы у нас нет, а порог, взятый с
        потолка, оценивал бы людей по выдуманному числу. «В ОКС» идёт без
        конверсии: передача оформляется отдельной карточкой и к встрече этого
        периода не относится. «Чек БФЛ» — только по сделкам с продуктом
        банкротства, без ФПА. План рядом с фактом месячный, а цвет у него —
        по темпу на сегодняшний день. Две последние колонки за линией — это не
        период, а снимок на сегодня: сколько сделок у человека в работе и
        сколько из них стоит дольше нормы своего этапа. Разбор по ним — на
        вкладке «Портфель».
      </div>
    </div>
  )
}

const KEYS = ['встречи', 'брак', 'икп', 'договор_без_оплаты', 'оплата',
  'окс_всего', 'окс_аз', 'окс_вки', 'чек_бфл_сумма', 'чек_бфл_сделок']

function blank() {
  const o = {}
  for (const k of KEYS) o[k] = 0
  return o
}

function add(acc, row) {
  for (const k of KEYS) acc[k] += Number(row[k] || 0)
}
