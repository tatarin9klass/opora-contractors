import React, { useEffect, useMemo, useState } from 'react'
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend,
} from 'recharts'
import { useAuth } from '../lib/auth.jsx'
import { todayISO } from '../lib/dateContext.js'
import {
  loadProfile, loadStageGuide, loadDaily, loadLeads,
  periodBounds, recentWeeks, recentMonths, toCsv, downloadCsv, formatMoscow,
  formatDayShort, DATA_START, LEAD_EXPORT_HEADERS, leadExportRow, plural,
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
// ЭКРАН РАЗДЕЛЁН НА ДВЕ ЯВНЫЕ ЧАСТИ, И ЭТО ГЛАВНОЕ В ЕГО УСТРОЙСТВЕ.
// Они отвечают на разные вопросы и считаются по разной логике дат, поэтому
// цифры в них НЕ СОВПАДАЮТ — и если не развести их визуально, первый же
// разговор будет «какая цифра настоящая».
//
//   «Результаты за период» — наша отчётная логика. Заявка считается в день
//   поступления, квал — в день квалификации, встреча — в день консультации,
//   договор — в день оплаты. Ровно эти цифры мы видим у себя.
//
//   «Заявки периода» — по дате создания заявки, стадия фактическая на
//   сегодня. Отвечает на другой вопрос: чем кончились именно те заявки,
//   которые сданы в эти дни.
//
// Сентябрьская заявка, отквалившаяся в октябре, даст квал в сентябрьских
// заявках и в октябрьских результатах. Обе цифры верные.
// ============================================================================

// Быстрые варианты закрывают ежедневный вопрос «сколько пришло», точные —
// разбор за неделю или месяц. Порядок от частого к редкому.
const MODES = [
  { id: 'today', label: 'Сегодня' },
  { id: 'yesterday', label: 'Вчера' },
  { id: 'd7', label: '7 дней' },
  { id: 'd30', label: '30 дней' },
  { id: 'week', label: 'Неделя' },
  { id: 'month', label: 'Месяц' },
  { id: 'range', label: 'Период' },
]

// Две ступени фирменного зелёного, проверенные на различимость при
// дальтонизме и на контраст к белому фону карточки. Не подбирались на глаз:
// пара даёт ΔE 17.5 по всем типам CVD при пороге 8 и контраст выше 3:1.
const C_LEADS = '#699E61'
const C_QUALS = '#2F6B2A'

// Встреч и договоров на графике намеренно нет. Заявок за день десятки, а
// договоров единицы: на одной шкале вторые превращаются в невидимую полоску
// у нуля, а разносить их по двум шкалам нельзя — две оси в одном графике
// рисуют связь, которой в данных нет. Эти два числа живут в плитках сверху и
// в таблице по источникам, где их видно точно.
const PAGE_SIZE = 50

// Три исхода, которыми живёт подрядчик. Порядок осмысленный: сначала то, что
// ещё может стать результатом, потом результат, потом потери — так читается
// как движение заявки, а не как случайный набор.
const OUTCOMES = [
  { id: 'в работе', label: 'В работе', cls: 'work',
    hint: 'исход ещё не определён' },
  { id: 'квал', label: 'Квал', cls: 'qual',
    hint: 'работа принята' },
  { id: 'брак', label: 'Брак', cls: 'junk',
    hint: 'закрыты без результата' },
]

const OUTCOME_CLS = { 'квал': 'qual', 'в работе': 'work', 'брак': 'junk' }

function Kpi({ label, value, sub, accent }) {
  return (
    <div className={`kpi-card ${accent || ''}`}>
      <div className="kpi-label">{label}</div>
      <div className="kpi-value">{value}</div>
      {sub && <div className="kpi-sub">{sub}</div>}
    </div>
  )
}

function SectionTitle({ title, note }) {
  return (
    <div className="portal-section-head">
      <h2 className="portal-section-title">{title}</h2>
      {note && <p className="portal-section-note">{note}</p>}
    </div>
  )
}

export default function PortalPage() {
  const { session, signOut } = useAuth()

  const [mode, setMode] = useState('d30')
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

  // Вид блока «по дням»: график или те же числа таблицей. Таблица здесь не
  // запасной вариант, а равноправный: по графику нельзя назвать точное
  // число, а в разговоре с нами подрядчику нужно именно оно.
  const [dayView, setDayView] = useState('chart')

  // Фильтры заявок. Скоупят всё, что ниже заголовка «Заявки периода»:
  // счётчики, таблицу и выгрузку. Выгрузка обязана отдавать ровно то, что
  // человек видит, — иначе он скачает файл и не найдёт в нём того, что
  // только что отфильтровал.
  const [group, setGroup] = useState('all')
  const [stageFilter, setStageFilter] = useState(new Set())
  const [search, setSearch] = useState('')
  const [sortDesc, setSortDesc] = useState(true)
  const [shown, setShown] = useState(PAGE_SIZE)
  const [guideOpen, setGuideOpen] = useState(false)

  const bounds = useMemo(
    () => periodBounds(mode, anchor, from, to),
    [mode, anchor, from, to],
  )
  const weeks = useMemo(() => recentWeeks(14), [])
  const months = useMemo(() => recentMonths(12), [])

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

  // Смена периода сбрасывает постраничный показ, но НЕ фильтры: человек
  // смотрит «отказы за сентябрь», потом «отказы за октябрь» — сбрасывать ему
  // фильтр на каждом шаге значит заставлять ставить его заново.
  useEffect(() => { setShown(PAGE_SIZE) }, [bounds.from, bounds.to])

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

  const byDay = useMemo(() => {
    const m = new Map()
    for (const r of daily) {
      const cur = m.get(r.fact_date)
        || { date: r.fact_date, leads: 0, quals: 0, meetings: 0, deals: 0, duplicates: 0 }
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
      const cur = m.get(r.source_marker)
        || { source: r.source_marker, leads: 0, quals: 0, meetings: 0, deals: 0, duplicates: 0 }
      cur.leads += r.leads || 0
      cur.quals += r.quals || 0
      cur.meetings += r.meetings || 0
      cur.deals += r.deals || 0
      cur.duplicates += r.duplicates || 0
      m.set(r.source_marker, cur)
    }
    return [...m.values()].sort((a, b) => b.leads - a.leads)
  }, [daily])

  // --- Заявки периода --------------------------------------------------------
  // Стадия заявки — это четырнадцать значений, и подрядчику из такого списка
  // не видно главного: за что ему засчитали, что ещё может засчитаться, а что
  // отбраковано. Поэтому поверх стадий лежит исход из трёх значений, и
  // разговор начинается с него.
  //
  // Группа приходит из базы (bfl_lead_stage_guide.outcome_group), а не
  // вычисляется здесь по названию стадии: иначе справочник жил бы в двух
  // местах и однажды разъехался бы.
  const groupOf = l => l.outcome_group || 'в работе'

  // Считаются по ВСЕМ заявкам периода, а не по отфильтрованным: иначе,
  // выбрав одну группу, человек увидит нули у остальных и решит, что данные
  // пропали.
  const groupCounts = useMemo(() => {
    const c = { 'квал': 0, 'в работе': 0, 'брак': 0 }
    for (const l of leads) c[groupOf(l)] = (c[groupOf(l)] || 0) + 1
    return c
  }, [leads])

  const stageCounts = useMemo(() => {
    const m = new Map()
    for (const l of leads) {
      const cur = m.get(l.stage)
        || { stage: l.stage, n: 0, qual: !!l.is_qual, group: groupOf(l) }
      cur.n += 1
      m.set(l.stage, cur)
    }
    const order = new Map(guide.map(g => [g.status_name, g.sort_order]))
    return [...m.values()].sort(
      (a, b) => (order.get(a.stage) ?? 999) - (order.get(b.stage) ?? 999),
    )
  }, [leads, guide])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    // Поиск по телефону терпит любой формат: человек копирует номер из своей
    // системы, где он записан через скобки и дефисы, а у нас лежит иначе.
    const digits = q.replace(/\D/g, '')
    return leads.filter(l => {
      if (group !== 'all' && groupOf(l) !== group) return false
      if (stageFilter.size && !stageFilter.has(l.stage)) return false
      if (!q) return true
      if (digits.length >= 3 && String(l.phone || '').replace(/\D/g, '').includes(digits)) return true
      return [l.utm, l.source_marker, l.stage]
        .some(v => String(v || '').toLowerCase().includes(q))
    })
  }, [leads, group, stageFilter, search])

  const sorted = useMemo(() => {
    const arr = [...filtered]
    arr.sort((a, b) => String(a.created_at || '').localeCompare(String(b.created_at || '')))
    return sortDesc ? arr.reverse() : arr
  }, [filtered, sortDesc])

  const qualsInFiltered = useMemo(() => filtered.filter(l => l.is_qual).length, [filtered])
  const filterOn = group !== 'all' || stageFilter.size > 0 || search.trim().length > 0

  // Выбор группы сбрасывает отмеченные стадии, и наоборот. Иначе человек
  // выбирает «Квал», потом щёлкает стадию из брака и получает пустой список
  // без единой подсказки, почему.
  function pickGroup(g) {
    setGroup(prev => (prev === g ? 'all' : g))
    setStageFilter(new Set())
    setShown(PAGE_SIZE)
  }

  function toggleStage(stage) {
    setGroup('all')
    setStageFilter(prev => {
      const next = new Set(prev)
      if (next.has(stage)) next.delete(stage); else next.add(stage)
      return next
    })
    setShown(PAGE_SIZE)
  }

  function resetFilters() {
    setGroup('all')
    setStageFilter(new Set())
    setSearch('')
    setShown(PAGE_SIZE)
  }

  function exportLeads() {
    downloadCsv(
      `zayavki_${bounds.from}_${bounds.to}.csv`,
      toCsv(LEAD_EXPORT_HEADERS, sorted.map(leadExportRow)),
    )
  }

  function exportGuide() {
    downloadCsv(
      'pamyatka_po_stadiyam.csv',
      toCsv(
        ['Стадия', 'Результат', 'Что означает'],
        guide.map(g => [g.status_name, g.outcome_group || '', g.description]),
      ),
    )
  }

  const periodLabel = bounds.from === bounds.to
    ? formatDayShort(bounds.from)
    : `${formatDayShort(bounds.from)} — ${formatDayShort(bounds.to)}`

  const qualRate = totals.leads ? (100 * totals.quals / totals.leads) : null

  // Профиля нет — значит доступ не действует: срок пароля истёк либо его
  // приостановили. Отличить одно от другого отсюда нельзя и не нужно: база
  // в обоих случаях не отдаёт ни строки, и делать подрядчику надо одно и то
  // же. Пустой кабинет без объяснения был бы хуже всего: человек решил бы,
  // что сломалось приложение, и стал бы искать ошибку там, где её нет.
  if (meLoaded && !me && !error) {
    return (
      <div className="portal-gate">
        <div className="portal-gate-card">
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
    <div className="portal">
      <div className="portal-topbar">
        <div className="portal-brand">
          <div className="portal-brand-name">{me?.contractor_name || 'Кабинет подрядчика'}</div>
          <div className="portal-brand-sub">статистика заявок · ЮК Опора · БФЛ</div>
        </div>
        <div className="portal-topbar-right">
          {me?.password_expires_at && (
            <span className="portal-muted">
              доступ до {formatMoscow(me.password_expires_at).split(' ')[0]}
            </span>
          )}
          <span className="portal-muted">{session?.user?.email}</span>
          <button className="btn btn-ghost btn-sm" onClick={signOut}>Выйти</button>
        </div>
      </div>

      <div className="portal-content">
        {!meLoaded && !error && <div className="loading">Загрузка...</div>}

        {error && (
          <div className="alert alert-danger" style={{ marginBottom: 16 }}>
            Не удалось загрузить данные: {error}
          </div>
        )}

        {/* ---- Период: одна строка фильтров на весь экран ---------------- */}
        <div className="portal-period">
          <div className="portal-chips">
            {MODES.map(m => (
              <button
                key={m.id}
                className={`filter-chip ${mode === m.id ? 'active' : ''}`}
                onClick={() => setMode(m.id)}
              >
                {m.label}
              </button>
            ))}
          </div>

          <div className="portal-period-detail">
            {mode === 'week' && (
              <select
                className="filter-select"
                value={periodBounds('week', anchor).from}
                onChange={e => setAnchor(e.target.value)}
              >
                {weeks.map(w => (
                  <option key={w.start} value={w.start}>
                    {formatDayShort(w.start)} — {formatDayShort(w.end)}
                  </option>
                ))}
              </select>
            )}

            {mode === 'month' && (
              <select
                className="filter-select"
                value={anchor.slice(0, 8) + '01'}
                onChange={e => setAnchor(e.target.value)}
              >
                {months.map(m => (
                  <option key={m.start} value={m.start}>{m.label}</option>
                ))}
              </select>
            )}

            {mode === 'range' && (
              <>
                <input
                  className="form-input portal-date" type="date" value={from}
                  min={DATA_START} max={todayISO()}
                  onChange={e => setFrom(e.target.value)}
                />
                <span className="portal-muted">—</span>
                <input
                  className="form-input portal-date" type="date" value={to}
                  min={DATA_START} max={todayISO()}
                  onChange={e => setTo(e.target.value)}
                />
              </>
            )}

            <span className="portal-period-label">
              {periodLabel}
              {loading && <span className="portal-muted"> · обновляем</span>}
            </span>
          </div>
        </div>

        {/* Во время загрузки держим прежние цифры приглушёнными, а не
            подменяем их скелетом: так ничего не прыгает и видно, что
            обновляется именно то, что уже на экране. */}
        <div className={loading ? 'portal-fading' : ''}>

          {/* ================= Результаты за период ===================== */}
          <SectionTitle
            title="Результаты за период"
            note="Заявка считается в день поступления, квал — в день квалификации,
                  встреча — в день консультации, договор — в день оплаты клиентом. Ровно эти
                  цифры мы видим у себя."
          />

          <div className="kpi-row portal-kpi">
            <Kpi label="Заявок" value={formatNum(totals.leads)} sub="поступило" />
            <Kpi
              label="Квалов" value={formatNum(totals.quals)} accent="green"
              sub={qualRate != null ? `${qualRate.toFixed(1)}% от заявок` : 'нет заявок'}
            />
            <Kpi label="Встреч" value={formatNum(totals.meetings)} sub="состоялось" />
            <Kpi label="Договоров" value={formatNum(totals.deals)} accent="green" sub="клиент оплатил" />
            <Kpi
              label="Дублей" value={formatNum(totals.duplicates)}
              accent={totals.duplicates > 0 ? 'yellow' : ''}
              sub="повторные обращения"
            />
          </div>

          {byDay.length > 1 && (
            <div className="info-card portal-card">
              <div className="portal-card-head">
                <div className="info-card-title" style={{ margin: 0 }}>Заявки и квалы по дням</div>
                <div className="portal-switch">
                  <button
                    className={`filter-chip ${dayView === 'chart' ? 'active' : ''}`}
                    onClick={() => setDayView('chart')}
                  >График</button>
                  <button
                    className={`filter-chip ${dayView === 'table' ? 'active' : ''}`}
                    onClick={() => setDayView('table')}
                  >Таблица</button>
                </div>
              </div>

              {dayView === 'chart' ? (
                <div className="portal-chart">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={byDay} margin={{ top: 8, right: 8, left: -20, bottom: 0 }}
                              barGap={2} barCategoryGap="22%">
                      <CartesianGrid stroke="var(--border-light)" vertical={false} />
                      <XAxis
                        dataKey="date" tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                        tickLine={false} axisLine={{ stroke: 'var(--border)' }}
                        tickFormatter={d => `${d.slice(8, 10)}.${d.slice(5, 7)}`}
                        minTickGap={12}
                      />
                      <YAxis
                        tick={{ fontSize: 11, fill: 'var(--text-muted)' }}
                        tickLine={false} axisLine={false} allowDecimals={false} width={44}
                      />
                      <Tooltip
                        cursor={{ fill: 'var(--green-bg)' }}
                        labelFormatter={d => formatDayShort(String(d))}
                        contentStyle={{
                          fontSize: 12, borderRadius: 8,
                          border: '1px solid var(--border)', boxShadow: 'var(--shadow)',
                        }}
                      />
                      <Legend wrapperStyle={{ fontSize: 12, paddingTop: 6 }} iconType="circle" iconSize={8} />
                      <Bar dataKey="leads" name="заявки" fill={C_LEADS} radius={[4, 4, 0, 0]} maxBarSize={28} />
                      <Bar dataKey="quals" name="квалы" fill={C_QUALS} radius={[4, 4, 0, 0]} maxBarSize={28} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              ) : (
                <div className="table-scroll" style={{ marginTop: 10 }}>
                  <table className="table-compact">
                    <thead>
                      <tr>
                        <th>Дата</th>
                        <th style={{ textAlign: 'right' }}>Заявок</th>
                        <th style={{ textAlign: 'right' }}>Квалов</th>
                        <th style={{ textAlign: 'right' }}>Встреч</th>
                        <th style={{ textAlign: 'right' }}>Договоров</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...byDay].reverse().map(d => (
                        <tr key={d.date}>
                          <td style={{ whiteSpace: 'nowrap' }}>{formatDayShort(d.date)}</td>
                          <td className="portal-num">{formatNum(d.leads)}</td>
                          <td className="portal-num" style={{ fontWeight: 600 }}>{formatNum(d.quals)}</td>
                          <td className="portal-num">{formatNum(d.meetings)}</td>
                          <td className="portal-num">{formatNum(d.deals)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          )}

          {bySource.length > 1 && (
            <div className="table-wrap portal-card">
              <div className="table-toolbar">
                <strong style={{ fontSize: 13 }}>По источникам</strong>
                <span className="portal-muted">источников: {bySource.length}</span>
              </div>
              <div className="table-scroll">
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
                        <td className="portal-num">{formatNum(s.leads)}</td>
                        <td className="portal-num" style={{ fontWeight: 600 }}>{formatNum(s.quals)}</td>
                        <td className="portal-num td-muted">
                          {s.leads ? `${(100 * s.quals / s.leads).toFixed(1)}%` : '—'}
                        </td>
                        <td className="portal-num">{formatNum(s.meetings)}</td>
                        <td className="portal-num">{formatNum(s.deals)}</td>
                        <td className="portal-num td-muted">{formatNum(s.duplicates)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {!loading && !totals.leads && !leads.length && (
            <div className="empty-state portal-card">
              <div className="empty-state-icon">📭</div>
              <h3>За этот период заявок нет</h3>
              <p>Выберите другой период — например, «30 дней».</p>
            </div>
          )}

          {/* ================= Заявки периода =========================== */}
          {leads.length > 0 && (
            <>
              <SectionTitle
                title="Заявки периода"
                note="Заявки, СОЗДАННЫЕ в выбранном периоде, со стадией на сегодня —
                      поэтому числа тут не совпадают с блоком выше, и это не ошибка:
                      там «сколько результата случилось за период», здесь «чем
                      кончились заявки, сданные за период». Выберите исход или
                      конкретную стадию — таблица и выгрузка подстроятся."
              />

              <div className="portal-filters">
                {/* Сначала исход, потом стадии. Подрядчик открывает кабинет с
                    тремя вопросами — за что засчитали, что ещё в работе, что
                    в браке, — и ответ на них должен стоять первым, а не
                    собираться из четырнадцати стадий вручную. */}
                <div className="portal-outcomes">
                  <button
                    className={`portal-outcome ${group === 'all' ? 'active' : ''}`}
                    onClick={() => { setGroup('all'); setStageFilter(new Set()); setShown(PAGE_SIZE) }}
                  >
                    <span className="portal-outcome-n">{formatNum(leads.length)}</span>
                    <span className="portal-outcome-label">Все заявки</span>
                  </button>
                  {OUTCOMES.map(o => {
                    const n = groupCounts[o.id] || 0
                    return (
                      <button
                        key={o.id}
                        className={`portal-outcome ${o.cls} ${group === o.id ? 'active' : ''}`}
                        onClick={() => pickGroup(o.id)}
                      >
                        <span className="portal-outcome-n">{formatNum(n)}</span>
                        <span className="portal-outcome-label">{o.label}</span>
                        <span className="portal-outcome-sub">
                          {leads.length ? `${((100 * n) / leads.length).toFixed(0)}% · ` : ''}
                          {o.hint}
                        </span>
                      </button>
                    )
                  })}
                </div>

                {/* Стадии под своим исходом, а не одним списком: так видно,
                    из чего сложилось каждое из трёх чисел выше. */}
                {OUTCOMES.map(o => {
                  const items = stageCounts.filter(s => s.group === o.id)
                  if (!items.length) return null
                  return (
                    <div key={o.id} className="portal-stage-group">
                      <div className={`portal-stage-group-title ${o.cls}`}>{o.label}</div>
                      <div className="portal-chips">
                        {items.map(s => (
                          <button
                            key={s.stage}
                            className={`filter-chip ${stageFilter.has(s.stage) ? 'active' : ''}`}
                            onClick={() => toggleStage(s.stage)}
                            title={`${((100 * s.n) / leads.length).toFixed(1)}% заявок периода`}
                          >
                            {s.stage}
                            <span className="portal-chip-count">{s.n}</span>
                          </button>
                        ))}
                      </div>
                    </div>
                  )
                })}
                <div className="portal-filters-row">
                  <input
                    className="search-input"
                    placeholder="Поиск по телефону, UTM или источнику"
                    value={search}
                    onChange={e => { setSearch(e.target.value); setShown(PAGE_SIZE) }}
                  />
                  {filterOn && (
                    <button className="btn btn-ghost btn-sm" onClick={resetFilters}>Сбросить</button>
                  )}
                  <span className="portal-muted portal-filters-count">
                    {filterOn
                      ? `${formatNum(filtered.length)} из ${formatNum(leads.length)}`
                      : `всего ${formatNum(leads.length)}`}
                    {' · квалов '}<b>{formatNum(qualsInFiltered)}</b>
                  </span>
                </div>
              </div>

              <div className="portal-export">
                <button
                  className="btn btn-primary btn-sm"
                  onClick={exportLeads}
                  disabled={!filtered.length}
                >
                  Скачать {formatNum(filtered.length)}{' '}
                  {plural(filtered.length, 'заявку', 'заявки', 'заявок')}
                </button>
                <button className="btn btn-secondary btn-sm" onClick={exportGuide} disabled={!guide.length}>
                  Памятка по стадиям
                </button>
                <span className="portal-muted">
                  CSV для Excel · телефон, дата создания, стадия, результат, UTM
                  {filterOn && ' · с учётом фильтра'}
                </span>
              </div>

              <div className="table-wrap portal-card">
                <div className="table-toolbar">
                  <strong style={{ fontSize: 13 }}>
                    {filterOn ? 'Отобранные заявки' : 'Все заявки периода'}
                  </strong>
                  <button className="btn btn-ghost btn-sm" onClick={() => setSortDesc(v => !v)}>
                    {sortDesc ? 'Сначала новые ↓' : 'Сначала старые ↑'}
                  </button>
                  <span className="portal-muted" style={{ marginLeft: 'auto' }}>
                    показано {formatNum(Math.min(shown, sorted.length))} из {formatNum(sorted.length)}
                  </span>
                </div>

                {sorted.length === 0 ? (
                  <div className="portal-empty-row">
                    Под фильтр ничего не попало.{' '}
                    <button className="btn btn-ghost btn-sm" onClick={resetFilters}>Сбросить фильтр</button>
                  </div>
                ) : (
                  <>
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
                          {sorted.slice(0, shown).map(l => (
                            <tr key={l.lead_id}>
                              <td className="td-mono" style={{ whiteSpace: 'nowrap' }}>{l.phone || '—'}</td>
                              <td style={{ whiteSpace: 'nowrap' }}>{formatMoscow(l.created_at)}</td>
                              <td>
                                <span className={`portal-badge ${OUTCOME_CLS[groupOf(l)] || 'work'}`}>
                                  {groupOf(l)}
                                </span>
                                {l.stage}
                              </td>
                              <td className="td-muted portal-utm" title={l.utm || ''}>{l.utm || '—'}</td>
                              <td className="td-mono td-muted">{l.source_marker}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    {shown < sorted.length && (
                      <div className="portal-more">
                        <button className="btn btn-secondary btn-sm" onClick={() => setShown(s => s + PAGE_SIZE)}>
                          Показать ещё {formatNum(Math.min(PAGE_SIZE, sorted.length - shown))}
                        </button>
                        <button className="btn btn-ghost btn-sm" onClick={() => setShown(sorted.length)}>
                          Показать все
                        </button>
                      </div>
                    )}
                  </>
                )}
              </div>
            </>
          )}
        </div>

        {/* ---- Памятка: свёрнута, потому что читают её один раз --------- */}
        {guide.length > 0 && (
          <div className="table-wrap portal-card">
            <button className="portal-accordion" onClick={() => setGuideOpen(v => !v)}>
              <strong style={{ fontSize: 13 }}>Памятка: что означает каждая стадия</strong>
              <span className="portal-muted">{guideOpen ? 'свернуть ▲' : 'развернуть ▼'}</span>
            </button>
            {guideOpen && (
              <div className="table-scroll">
                <table>
                  <thead>
                    <tr>
                      <th style={{ width: 230 }}>Стадия</th>
                      <th style={{ width: 110 }}>Результат</th>
                      <th>Что означает</th>
                    </tr>
                  </thead>
                  <tbody>
                    {guide.map(g => (
                      <tr key={g.status_name}>
                        <td style={{ fontWeight: 600 }}>{g.status_name}</td>
                        <td>
                          <span className={`portal-badge ${OUTCOME_CLS[g.outcome_group] || 'work'}`}>
                            {g.outcome_group || 'в работе'}
                          </span>
                        </td>
                        <td style={{ fontSize: 12, lineHeight: 1.55 }}>{g.description}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        <div className="portal-footer">
          Построчные данные доступны с 1 апреля 2026 года. Стадии обновляются
          автоматически вслед за нашей воронкой. Вопросы по конкретной заявке —
          менеджеру ЮК Опора, с номером телефона из выгрузки.
        </div>
      </div>
    </div>
  )
}
