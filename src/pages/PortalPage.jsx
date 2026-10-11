import React, { useEffect, useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { useAuth } from '../lib/auth.jsx'
import { todayISO } from '../lib/dateContext.js'
import {
  loadProfile, loadStageGuide, loadDaily, loadLeads,
  periodBounds, recentWeeks, toCsv, downloadCsv, formatMoscow,
  LEAD_EXPORT_HEADERS, leadExportRow,
} from '../lib/portal.js'
import { formatNum } from '../lib/helpers.js'

// ============================================================================
// Кабинет подрядчика. Отдельный экран целиком: ни дашборда направления, ни
// меню, ни переключателя направлений здесь нет.
//
// ЧТО ВИДНО: свои заявки и свои результаты. Что НЕ видно ни при каких
// условиях: расход, выручка, стоимость лида и квала, ставка, другие
// подрядчики, менеджеры, Автоправо. Этих чисел нет не на экране — их нет в
// ответе базы, и получить их запросом мимо интерфейса тоже нельзя.
//
// ГЛАВНОЕ В УСТРОЙСТВЕ ЭКРАНА — ДВА БЛОКА С РАЗНОЙ ЛОГИКОЙ ДАТ, и подпись об
// этом стоит прямо между ними. Иначе первый же вопрос подрядчика будет «а
// почему в выгрузке квалов меньше, чем на дашборде», и отвечать на него
// придётся каждый месяц заново:
//
//   Результаты (наша отчётная логика) — квал считается в день квалификации,
//   встреча в день встречи, договор в день оплаты. Так считает всё наше
//   приложение, по этим цифрам принимаются решения.
//
//   Заявки (выгрузка) — по дате создания заявки, стадия фактическая на
//   сейчас. Отвечает на другой вопрос: чем кончились именно те заявки,
//   которые сданы в этот период.
//
// Сентябрьская заявка, отквалившаяся в октябре, попадёт в сентябрьскую
// выгрузку как квал и в октябрьские результаты как квал. Обе цифры верные.
// ============================================================================

const MODES = [
  { id: 'day', label: 'День' },
  { id: 'week', label: 'Неделя' },
  { id: 'range', label: 'Период' },
]

function Kpi({ label, value, sub, accent }) {
  return (
    <div className={`kpi-card ${accent || ''}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  )
}

export default function PortalPage() {
  const { session, signOut } = useAuth()

  const [mode, setMode] = useState('week')
  const [anchor, setAnchor] = useState(todayISO())
  const [from, setFrom] = useState(todayISO())
  const [to, setTo] = useState(todayISO())

  const [me, setMe] = useState(null)
  const [meLoaded, setMeLoaded] = useState(false)
  const [guide, setGuide] = useState([])
  const [daily, setDaily] = useState([])
  const [leads, setLeads] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const bounds = useMemo(() => periodBounds(mode, anchor, from, to), [mode, anchor, from, to])
  const weeks = useMemo(() => recentWeeks(14), [])

  useEffect(() => {
    Promise.all([loadProfile(), loadStageGuide()])
      .then(([p, g]) => { setMe(p); setGuide(g) })
      .catch(e => setError(String(e?.message || e)))
      .finally(() => setMeLoaded(true))
  }, [])

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    Promise.all([loadDaily(bounds.from, bounds.to), loadLeads(bounds.from, bounds.to)])
      .then(([d, l]) => { if (!cancelled) { setDaily(d); setLeads(l) } })
      .catch(e => { if (!cancelled) setError(String(e?.message || e)) })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [bounds.from, bounds.to])

  // --- Итоги по нашей отчётной логике ---------------------------------------
  const totals = useMemo(() => {
    const t = { leads: 0, quals: 0, meetings: 0, deals: 0, duplicates: 0 }
    for (const r of daily) {
      t.leads += r.leads || 0
      t.quals += r.quals || 0
      t.meetings += r.meetings || 0
      t.deals += r.deals || 0
      t.duplicates += r.duplicates || 0
    }
    return t
  }, [daily])

  // По дням для графика и таблицы: источники подрядчика складываются, но в
  // таблице остаются раскрытыми — если источников несколько, подрядчику
  // важно видеть, какой из них дал результат.
  const byDay = useMemo(() => {
    const m = new Map()
    for (const r of daily) {
      const cur = m.get(r.fact_date) || { date: r.fact_date, leads: 0, quals: 0, meetings: 0, deals: 0, duplicates: 0 }
      cur.leads += r.leads || 0
      cur.quals += r.quals || 0
      cur.meetings += r.meetings || 0
      cur.deals += r.deals || 0
      cur.duplicates += r.duplicates || 0
      m.set(r.fact_date, cur)
    }
    return [...m.values()].sort((a, b) => a.date.localeCompare(b.date))
  }, [daily])

  const bySource = useMemo(() => {
    const m = new Map()
    for (const r of daily) {
      const cur = m.get(r.source_marker) || { source: r.source_marker, leads: 0, quals: 0, meetings: 0, deals: 0, duplicates: 0 }
      cur.leads += r.leads || 0
      cur.quals += r.quals || 0
      cur.meetings += r.meetings || 0
      cur.deals += r.deals || 0
      cur.duplicates += r.duplicates || 0
      m.set(r.source_marker, cur)
    }
    return [...m.values()].sort((a, b) => b.leads - a.leads)
  }, [daily])

  // --- Разбивка выгрузки по стадиям ------------------------------------------
  // Считается по тем же строкам, что уходят в файл, поэтому сходится с
  // выгрузкой строка в строку. Именно этот блок объясняет расхождение с
  // блоком результатов лучше любой подписи.
  const stageBreakdown = useMemo(() => {
    const m = new Map()
    for (const l of leads) {
      const cur = m.get(l.stage) || { stage: l.stage, n: 0, qual: !!l.is_qual }
      cur.n += 1
      m.set(l.stage, cur)
    }
    const order = new Map(guide.map(g => [g.status_name, g.sort_order]))
    return [...m.values()].sort(
      (a, b) => (order.get(a.stage) ?? 999) - (order.get(b.stage) ?? 999),
    )
  }, [leads, guide])

  const qualsInExport = useMemo(() => leads.filter(l => l.is_qual).length, [leads])

  function exportLeads() {
    const rows = leads.map(leadExportRow)
    downloadCsv(
      `zayavki_${bounds.from}_${bounds.to}.csv`,
      toCsv(LEAD_EXPORT_HEADERS, rows),
    )
  }

  function exportGuide() {
    downloadCsv(
      'pamyatka_po_stadiyam.csv',
      toCsv(
        ['Стадия', 'Считается квалом', 'Что означает'],
        guide.map(g => [g.status_name, g.is_qual ? 'да' : 'нет', g.description]),
      ),
    )
  }

  const periodLabel = bounds.from === bounds.to
    ? bounds.from.split('-').reverse().join('.')
    : `${bounds.from.split('-').reverse().join('.')} — ${bounds.to.split('-').reverse().join('.')}`

  const qualRate = totals.leads ? (100 * totals.quals / totals.leads) : null

  // Профиля нет — значит доступ не действует: срок пароля истёк либо его
  // приостановили. Отличить одно от другого отсюда нельзя и не нужно: база
  // в обоих случаях не отдаёт ни строки, и делать подрядчику надо одно и то
  // же — попросить новый пароль. Пустой кабинет без объяснения был бы хуже
  // всего: человек решил бы, что сломалось приложение, и стал бы искать
  // ошибку там, где её нет.
  if (meLoaded && !me && !error) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
        <div style={{ background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 32, width: 420, textAlign: 'center' }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>🔒</div>
          <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>Срок доступа истёк</div>
          <div style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6 }}>
            Пароль в кабинет действует месяц. Запросите новый у вашего менеджера
            ЮК Опора — статистика откроется сразу после входа с ним.
          </div>
          <div style={{ marginTop: 18, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{session?.user?.email}</span>
            <button className="btn btn-secondary btn-sm" onClick={signOut}>Выйти</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)' }}>
      {/* Шапка кабинета: название подрядчика, а не наше направление — человек
          должен сразу видеть, чей кабинет открыт. */}
      <div className="topbar" style={{ position: 'sticky', top: 0, zIndex: 5 }}>
        <div className="topbar-title">
          {me?.contractor_name || 'Кабинет подрядчика'}
          <span style={{ fontSize: 12, fontWeight: 400, color: 'var(--text-muted)', marginLeft: 10 }}>
            статистика заявок · БФЛ
          </span>
        </div>
        <div className="topbar-actions" style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          {me?.password_expires_at && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              пароль до {formatMoscow(me.password_expires_at).split(' ')[0]}
            </span>
          )}
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{session?.user?.email}</span>
          <button className="btn btn-ghost btn-sm" onClick={signOut}>Выйти</button>
        </div>
      </div>

      <div className="page-content" style={{ maxWidth: 1180, margin: '0 auto' }}>
        {!me && !error && <div className="loading">Загрузка...</div>}

        {error && (
          <div className="alert alert-danger" style={{ marginBottom: 16 }}>
            Не удалось загрузить данные: {error}
          </div>
        )}

        {/* --- Выбор периода --- */}
        <div className="info-card" style={{ marginBottom: 16 }}>
          <div className="filters-bar" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            {MODES.map(m => (
              <div
                key={m.id}
                className={`filter-chip ${mode === m.id ? 'active' : ''}`}
                onClick={() => setMode(m.id)}
                style={{ cursor: 'pointer' }}
              >
                {m.label}
              </div>
            ))}

            {mode === 'day' && (
              <input
                className="form-input"
                type="date"
                value={anchor}
                max={todayISO()}
                onChange={e => setAnchor(e.target.value)}
                style={{ width: 170 }}
              />
            )}

            {mode === 'week' && (
              <select
                className="filter-select"
                value={periodBounds('week', anchor).from}
                onChange={e => setAnchor(e.target.value)}
              >
                {weeks.map(w => (
                  <option key={w.start} value={w.start}>
                    {w.start.split('-').reverse().join('.')} — {w.end.split('-').reverse().join('.')}
                  </option>
                ))}
              </select>
            )}

            {mode === 'range' && (
              <>
                <input
                  className="form-input" type="date" value={from} max={todayISO()}
                  onChange={e => setFrom(e.target.value)} style={{ width: 170 }}
                />
                <span style={{ color: 'var(--text-muted)' }}>—</span>
                <input
                  className="form-input" type="date" value={to} max={todayISO()}
                  onChange={e => setTo(e.target.value)} style={{ width: 170 }}
                />
              </>
            )}

            <div style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-muted)' }}>
              {loading ? 'считаем...' : periodLabel}
            </div>
          </div>
          <div className="form-hint" style={{ marginTop: 8 }}>
            Неделя отчётная — с четверга по среду. Так считает весь наш отчёт, и
            обсуждать динамику удобнее в одних и тех же границах.
          </div>
        </div>

        {/* --- Итоги по нашей отчётной логике --- */}
        <div className="kpi-row" style={{ marginBottom: 8 }}>
          <Kpi label="Заявок" value={formatNum(totals.leads)} sub="по дате поступления" />
          <Kpi
            label="Квалов" value={formatNum(totals.quals)} accent="green"
            sub={qualRate != null ? `${qualRate.toFixed(1)}% от заявок` : null}
          />
          <Kpi label="Встреч" value={formatNum(totals.meetings)} sub="состоявшихся консультаций" />
          <Kpi label="Договоров" value={formatNum(totals.deals)} accent="green" />
          <Kpi
            label="Дублей" value={formatNum(totals.duplicates)}
            accent={totals.duplicates > 0 ? 'yellow' : ''}
            sub="повторные обращения"
          />
        </div>
        <div className="form-hint" style={{ marginBottom: 16 }}>
          Отчётная логика: заявка считается в день поступления, квал — в день
          квалификации, встреча — в день консультации, договор — в день оплаты.
          Поэтому квал по сентябрьской заявке, сделанный в октябре, попадёт в
          октябрь. Ровно эти цифры мы видим у себя.
        </div>

        {/* --- Динамика --- */}
        {byDay.length > 1 && (
          <div className="info-card" style={{ marginBottom: 16 }}>
            <div className="info-card-title">По дням</div>
            <div style={{ height: 240, marginTop: 8 }}>
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={byDay} margin={{ top: 4, right: 8, left: -18, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" vertical={false} />
                  <XAxis
                    dataKey="date" tick={{ fontSize: 11 }}
                    tickFormatter={d => d.slice(8, 10) + '.' + d.slice(5, 7)}
                  />
                  <YAxis tick={{ fontSize: 11 }} allowDecimals={false} />
                  <Tooltip
                    labelFormatter={d => String(d).split('-').reverse().join('.')}
                    formatter={(v, n) => [v, n]}
                  />
                  <Legend wrapperStyle={{ fontSize: 12 }} />
                  <Bar dataKey="leads" name="заявки" fill="#8FBF8A" />
                  <Bar dataKey="quals" name="квалы" fill="#3A7E34" />
                  <Bar dataKey="meetings" name="встречи" fill="#2c6e8f" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}

        {/* --- Таблицы: по источникам и по дням --- */}
        {bySource.length > 0 && (
          <div className="table-wrap" style={{ marginBottom: 16 }}>
            <div className="table-toolbar">
              <strong style={{ fontSize: 13 }}>По источникам</strong>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {bySource.length === 1 ? 'один источник' : `источников: ${bySource.length}`}
              </span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Источник</th>
                  <th style={{ textAlign: 'right' }}>Заявок</th>
                  <th style={{ textAlign: 'right' }}>Квалов</th>
                  <th style={{ textAlign: 'right' }}>в квал</th>
                  <th style={{ textAlign: 'right' }}>Встреч</th>
                  <th style={{ textAlign: 'right' }}>Договоров</th>
                  <th style={{ textAlign: 'right' }}>Дублей</th>
                </tr>
              </thead>
              <tbody>
                {bySource.map(s => (
                  <tr key={s.source}>
                    <td className="td-mono">{s.source}</td>
                    <td style={{ textAlign: 'right' }}>{formatNum(s.leads)}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatNum(s.quals)}</td>
                    <td style={{ textAlign: 'right' }} className="td-muted">
                      {s.leads ? `${(100 * s.quals / s.leads).toFixed(1)}%` : '—'}
                    </td>
                    <td style={{ textAlign: 'right' }}>{formatNum(s.meetings)}</td>
                    <td style={{ textAlign: 'right' }}>{formatNum(s.deals)}</td>
                    <td style={{ textAlign: 'right' }} className="td-muted">{formatNum(s.duplicates)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* --- Выгрузка --- */}
        <div className="info-card" style={{ marginBottom: 16 }}>
          <div className="info-card-title">Выгрузка заявок</div>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, margin: '6px 0 12px' }}>
            Здесь другая логика дат, и это не ошибка: в файл попадают заявки,
            <b> созданные</b> в выбранном периоде, со стадией <b>на сегодня</b>.
            Блок выше отвечает на вопрос «сколько результата случилось за период»,
            а выгрузка — «чем кончились заявки, сданные за период». Поэтому числа
            квалов в двух блоках различаются, и оба верны.
          </p>
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
            <button className="btn btn-primary btn-sm" onClick={exportLeads} disabled={loading || !leads.length}>
              Скачать заявки ({formatNum(leads.length)})
            </button>
            <button className="btn btn-secondary btn-sm" onClick={exportGuide} disabled={!guide.length}>
              Скачать памятку по стадиям
            </button>
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              CSV, открывается в Excel · из них квалов: <b>{formatNum(qualsInExport)}</b>
            </span>
          </div>
        </div>

        {/* --- Стадии выгрузки --- */}
        {stageBreakdown.length > 0 && (
          <div className="table-wrap" style={{ marginBottom: 16 }}>
            <div className="table-toolbar">
              <strong style={{ fontSize: 13 }}>Чем кончились заявки периода</strong>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                всего {formatNum(leads.length)} · стадия на сегодня
              </span>
            </div>
            <table>
              <thead>
                <tr>
                  <th>Стадия</th>
                  <th style={{ textAlign: 'right' }}>Заявок</th>
                  <th style={{ textAlign: 'right' }}>Доля</th>
                  <th style={{ textAlign: 'center' }}>Квал</th>
                </tr>
              </thead>
              <tbody>
                {stageBreakdown.map(s => (
                  <tr key={s.stage}>
                    <td>{s.stage}</td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatNum(s.n)}</td>
                    <td style={{ textAlign: 'right' }} className="td-muted">
                      {leads.length ? `${(100 * s.n / leads.length).toFixed(1)}%` : '—'}
                    </td>
                    <td style={{ textAlign: 'center' }}>{s.qual ? '✅' : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        {/* --- Последние заявки, чтобы не скачивать файл ради трёх строк --- */}
        {leads.length > 0 && (
          <div className="table-wrap" style={{ marginBottom: 16 }}>
            <div className="table-toolbar">
              <strong style={{ fontSize: 13 }}>Заявки периода</strong>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                {leads.length > 100 ? 'первые 100 строк, остальное в файле' : `строк: ${leads.length}`}
              </span>
            </div>
            <div className="table-scroll">
              <table className="table-compact">
                <thead>
                  <tr>
                    <th>Телефон</th>
                    <th>Создана</th>
                    <th>Стадия</th>
                    <th>UTM</th>
                    <th>Источник</th>
                  </tr>
                </thead>
                <tbody>
                  {leads.slice(0, 100).map(l => (
                    <tr key={l.lead_id}>
                      <td className="td-mono">{l.phone || '—'}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>{formatMoscow(l.created_at)}</td>
                      <td>
                        {l.stage}
                        {l.is_qual && <span style={{ marginLeft: 6 }}>✅</span>}
                      </td>
                      <td className="td-muted" style={{ maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {l.utm || '—'}
                      </td>
                      <td className="td-mono td-muted">{l.source_marker}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}

        {!loading && !leads.length && !totals.leads && (
          <div className="empty-state" style={{ marginBottom: 16 }}>
            <div className="empty-state-icon">📭</div>
            За этот период заявок нет.
          </div>
        )}

        {/* --- Памятка по стадиям --- */}
        {guide.length > 0 && (
          <div className="table-wrap" style={{ marginBottom: 24 }}>
            <div className="table-toolbar">
              <strong style={{ fontSize: 13 }}>Памятка по стадиям</strong>
              <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                что означает стадия заявки
              </span>
            </div>
            <table>
              <thead>
                <tr>
                  <th style={{ width: 240 }}>Стадия</th>
                  <th style={{ width: 70, textAlign: 'center' }}>Квал</th>
                  <th>Что означает</th>
                </tr>
              </thead>
              <tbody>
                {guide.map(g => (
                  <tr key={g.status_name}>
                    <td style={{ fontWeight: 600 }}>{g.status_name}</td>
                    <td style={{ textAlign: 'center' }}>{g.is_qual ? '✅' : ''}</td>
                    <td style={{ fontSize: 12, lineHeight: 1.55 }}>{g.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}

        <div style={{ fontSize: 11, color: 'var(--text-muted)', paddingBottom: 24, lineHeight: 1.6 }}>
          Построчные данные доступны с 1 апреля 2026 года. Стадии обновляются
          автоматически вслед за нашей воронкой. Вопросы по конкретной заявке —
          менеджеру ЮК Опора, с номером телефона из выгрузки.
        </div>
      </div>
    </div>
  )
}
