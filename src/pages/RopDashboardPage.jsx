import React, { useEffect, useMemo, useState } from 'react'
import { todayISO } from '../lib/dateContext.js'
import {
  loadRopData, periodBounds, recentMonths, sumRows, planFor, runRate, planStatus,
  paceTarget, formatMoneyShort, GROUPS, byTeam, prevBounds, dailySeries, quotaPerDay,
} from '../lib/rop.js'
import { formatNum, plural } from '../lib/helpers.js'

// ============================================================================
// «Главное» — единственный экран отдела, на котором стоит план.
//
// ЗДЕСЬ НАМЕРЕННО МАЛО. Раньше на этой вкладке жили встречи, брак, средний
// чек, ФПА, воронка по этапам, потери по причинам и скорость переходов —
// одиннадцать блоков. Руководитель отдела отвечает за одно число: сколько
// договоров банкротства заключено. Всё остальное объясняет это число, но
// рядом с ним превращает экран в отчёт, который читают раз в месяц вместо
// того, чтобы смотреть каждый день.
//
// ЧТО ОСТАЛОСЬ. Договоры тремя видами, темп, квота — и один график. Больше
// ничего, пока не попросят обратно.
//
// РАЗВЁРТКА НА МАРКЕТИНГ И РЕКОМЕНДАЦИИ СТОИТ ВСЕГДА, без раскрытия по
// клику: у заявки от агента и у заявки по рекомендации разная доходимость,
// и общая цифра её прячет.
// ============================================================================

const MODES = [
  { id: 'month', label: 'Месяц' },
  { id: 'week', label: 'Неделя' },
  { id: 'range', label: 'Период' },
]

function Metric({ label, fact, plan, unit, inverse, additive = true, bounds, sub, was, big, children }) {
  // Цвет ставится по темпу, а не по месячному плану целиком: иначе середина
  // месяца всегда красная. Сам план в подписи остаётся месячным — подменять
  // его нельзя, человек должен видеть ту цифру, на которую подписался.
  const target = bounds ? paceTarget(plan, bounds.from, bounds.to, additive) : plan
  const status = planStatus(fact, target, inverse)
  const partial = target != null && plan != null && Math.round(target) !== Math.round(plan)
  return (
    <div className={`rop-metric ${big ? 'big' : ''} ${status}`}>
      <div className="rop-metric-label">{label}</div>
      <div className="rop-metric-value">
        {fact == null ? '—' : unit === '₽' ? formatMoneyShort(fact) : formatNum(fact)}
        {unit === '%' && fact != null ? '%' : ''}
      </div>
      {plan != null && (
        <div className="rop-metric-plan">
          план {unit === '₽' ? formatMoneyShort(plan) : formatNum(plan)}
          {fact != null && plan > 0 && (
            <span className="rop-metric-pct"> · {Math.round((100 * fact) / plan)}%</span>
          )}
          {partial && (
            <span className="rop-metric-pct"> · к этому дню {formatNum(Math.round(target))}</span>
          )}
        </div>
      )}
      {/* «Было» рядом с цифрой отвечает на вопрос, который иначе остаётся
          без ответа: двадцать четыре договора — это много или мало. Без
          прошлого периода любая метрика читается как нейтральная. */}
      {was != null && fact != null && (
        <div className="rop-metric-was">
          было {formatNum(was)}
          {was > 0 && (
            <span className={`rop-delta ${
              (fact > was) === !inverse ? 'up' : fact === was ? '' : 'down'}`}>
              {fact === was ? ' ·' : fact > was ? ' ↑' : ' ↓'}
              {fact === was ? ' столько же' : ` ${Math.abs(Math.round((100 * (fact - was)) / was))}%`}
            </span>
          )}
        </div>
      )}
      {sub && <div className="rop-metric-sub">{sub}</div>}
      {children}
    </div>
  )
}

// Развёртка на источники. Видна всегда, а не по клику: у заявки от агента и
// у заявки по рекомендации разная доходимость, и общая цифра её прячет.
//
// Маркетинг и рекомендации показываются всегда, даже нулём: так карточки не
// прыгают по высоте от периода к периоду. «Прочее» появляется, только когда
// в нём что-то есть, — пустая строка в каждой плитке отвлекала бы.
function Split({ rows, pick }) {
  const vals = GROUPS.map(g => ({ g, v: pick(sumRows(rows, g.id)) }))
  const shown = vals.filter(x => x.g.id !== 'прочее' || x.v)
  if (!shown.some(x => x.v)) return null
  const total = vals.reduce((a, x) => a + (x.v || 0), 0)

  return (
    <div className="rop-split">
      {shown.map(({ g, v }) => (
        <div key={g.id} className="rop-split-row">
          <span className={`rop-dot ${g.id === 'маркетинг' ? 'mk' : g.id === 'рекомендации' ? 'rec' : 'oth'}`} />
          <span className="rop-split-label">{g.label}</span>
          <span className="rop-split-value">{formatNum(v)}</span>
          <span className="rop-split-pct">{total ? Math.round((100 * (v || 0)) / total) + '%' : ''}</span>
        </div>
      ))}
    </div>
  )
}

// Плавная кривая через дневные значения — монотонный кубический сплайн
// (Фрич–Карлсон). Обычный сглаживающий сплайн между двумя нулями провисает
// НИЖЕ нуля и рисует отрицательные договоры; монотонный не выходит за
// пределы соседних значений и такого не делает.
function smoothPath(pts) {
  const n = pts.length
  if (!n) return ''
  if (n === 1) return `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
  const dx = [], s = []
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0])
    s.push((pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0]))
  }
  const m = new Array(n)
  m[0] = s[0]
  m[n - 1] = s[n - 2]
  for (let i = 1; i < n - 1; i++) m[i] = s[i - 1] * s[i] <= 0 ? 0 : (s[i - 1] + s[i]) / 2
  for (let i = 0; i < n - 1; i++) {
    if (s[i] === 0) { m[i] = 0; m[i + 1] = 0; continue }
    const a = m[i] / s[i], b = m[i + 1] / s[i]
    const h = Math.hypot(a, b)
    if (h > 3) { const t = 3 / h; m[i] = t * a * s[i]; m[i + 1] = t * b * s[i] }
  }
  let d = `M${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i]
    d += ` C${(pts[i][0] + h / 3).toFixed(1)} ${(pts[i][1] + (m[i] * h) / 3).toFixed(1)}`
      + `, ${(pts[i + 1][0] - h / 3).toFixed(1)} ${(pts[i + 1][1] - (m[i + 1] * h) / 3).toFixed(1)}`
      + `, ${pts[i + 1][0].toFixed(1)} ${pts[i + 1][1].toFixed(1)}`
  }
  return d
}

// Договоры по дням против дневной нормы.
//
// ЛИНИЯ НОРМЫ ГОРИЗОНТАЛЬНА — это план, разложенный на дни поровну. Она не
// прогноз, а линейка: по ней видно, какие дни вытягивают месяц, а какие
// проваливают, не считая ничего в уме.
//
// Будущие дни не рисуются вовсе: кривая обрывается на сегодняшнем. Довести
// её до конца месяца значило бы показать падение в ноль там, где просто
// ещё не наступило завтра.
function DailyPlan({ дни, норма }) {
  const W = 760, H = 220, L = 34, R = 46, T = 20, B = 30
  const n = дни.length
  const факты = дни.filter(d => d.факт != null)
  const hi = Math.max(норма || 0, ...факты.map(d => d.факт), 1)
  const top = hi * 1.25
  const X = i => L + ((W - L - R) * i) / Math.max(1, n - 1)
  const Y = v => T + (H - T - B) - ((H - T - B) * v) / top

  const step = Math.max(1, Math.ceil(hi / 4))
  const ticks = []
  for (let v = 0; v <= hi; v += step) ticks.push(v)

  const шаг = Math.max(1, Math.round(n / 8))
  const dd = iso => iso.slice(8) + '.' + iso.slice(5, 7)

  // Точки держат СВОЙ номер дня в периоде, а не позицию в отфильтрованном
  // списке. Сейчас пропуски бывают только в хвосте (будущее), и разницы нет,
  // но стоит появиться дыре в середине — и кривая поехала бы по датам.
  const точки = []
  дни.forEach((d, i) => { if (d.факт != null) точки.push({ i, v: d.факт, дата: d.дата }) })
  const pts = точки.map(p => [X(p.i), Y(p.v)])
  const кривая = smoothPath(pts)
  const заливка = pts.length > 1
    ? `${кривая} L${pts[pts.length - 1][0].toFixed(1)} ${Y(0).toFixed(1)} L${pts[0][0].toFixed(1)} ${Y(0).toFixed(1)} Z`
    : ''

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="rop-burnup">
      {ticks.map(v => (
        <g key={v}>
          <line x1={L} y1={Y(v)} x2={W - R} y2={Y(v)} stroke="#e4ebe2" />
          <text x={L - 6} y={Y(v) + 3.5} fontSize="9.5" fill="#6b7670" textAnchor="end">{v}</text>
        </g>
      ))}
      <text x={L - 6} y={T - 7} fontSize="9" fill="#6b7670" textAnchor="end">шт</text>

      {заливка && <path d={заливка} fill="#1f6f3f" opacity="0.08" />}
      {кривая && <path d={кривая} fill="none" stroke="#1f6f3f" strokeWidth="2.4"
                       strokeLinejoin="round" strokeLinecap="round" />}

      {/* Точка и подпись только там, где договоры были: подписывать каждый
          ноль значит засеять график нулями и спрятать за ними содержание. */}
      {точки.map(p => (p.v ? (
        <g key={p.дата}>
          <circle cx={X(p.i)} cy={Y(p.v)} r="3" fill="#1f6f3f" stroke="#fff" strokeWidth="1.5" />
          <text x={X(p.i)} y={Y(p.v) - 8} fontSize="9" fontWeight="600"
                fill="#1a1f1c" textAnchor="middle">{p.v}</text>
        </g>
      ) : null))}

      <line x1={L} y1={Y(0)} x2={W - R} y2={Y(0)} stroke="#c9d3c7" />

      {норма != null && (
        <>
          <line x1={L} y1={Y(норма)} x2={W - R} y2={Y(норма)}
                stroke="#eb6834" strokeWidth="1.8" strokeDasharray="5 3" />
          <text x={W - R + 5} y={Y(норма) + 3.5} fontSize="10.5" fontWeight="700" fill="#eb6834">
            {formatNum(Math.round(норма * 10) / 10)}
          </text>
        </>
      )}

      {дни.map((d, i) => (i % шаг === 0 ? (
        <text key={d.дата} x={X(i)} y={H - 8} fontSize="8.5" fill="#6b7670"
              textAnchor="middle">{dd(d.дата)}</text>
      ) : null))}
    </svg>
  )
}

export default function RopDashboardPage({ team = null }) {
  const [mode, setMode] = useState('month')
  const [anchor, setAnchor] = useState(todayISO())
  const [from, setFrom] = useState(todayISO())
  const [to, setTo] = useState(todayISO())
  const [data, setData] = useState(null)
  const [prev, setPrev] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  const months = useMemo(() => recentMonths(12), [])
  const bounds = useMemo(
    () => periodBounds(mode, anchor, from, to),
    [mode, anchor, from, to],
  )

  useEffect(() => {
    let cancelled = false
    setLoading(true)
    setError('')
    loadRopData(bounds.from, bounds.to)
      .then(d => { if (!cancelled) setData(d) })
      .catch(e => { if (!cancelled) setError(String(e?.message || e)) })
      .finally(() => { if (!cancelled) setLoading(false) })

    // Прошлый сопоставимый период грузится отдельно и молча: если он не
    // придёт, экран просто останется без сравнения, а не сломается.
    const pb = prevBounds(mode, bounds.from, bounds.to)
    loadRopData(pb.from, pb.to)
      .then(d => { if (!cancelled) setPrev(d) })
      .catch(() => { if (!cancelled) setPrev(null) })
    return () => { cancelled = true }
  }, [bounds.from, bounds.to, mode])

  const rows = byTeam(data?.daily || [], team)
  const plans = data?.plans || []
  const total = useMemo(() => sumRows(rows), [rows])
  const план = planFor(plans, bounds.from, 'оксвсего', null, team)

  const было = useMemo(
    () => (prev ? sumRows(byTeam(prev.daily || [], team)) : null),
    [prev, team],
  )
  const rr = runRate(total.окс_бфл, bounds.from, bounds.to)
  const квота = quotaPerDay(план, total.окс_бфл, bounds.to)
  const ряд = dailySeries(rows, bounds.from, bounds.to, план)

  if (loading && !data) return <div className="loading">Загрузка...</div>

  return (
    <div className={loading ? 'portal-fading' : ''}>
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

      {/* ---- Период ---- */}
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

      {/* ---- Договоры ---- */}
      <div className="portal-section-head">
        <h2 className="portal-section-title">Заключённые договоры</h2>
      </div>

      <div className="rop-metrics">
        {/* БФЛ опознаётся по депозиту АУ среди позиций сделки, а не по
            названию услуги: реструктуризация — тоже банкротство, и депозит
            у неё тоже есть. АЗ и ВКИ продаются поверх договора, поэтому
            сделка может попасть и в БФЛ, и в АЗ — три плитки намеренно не
            складываются в одну сумму. */}
        <Metric label="БФЛ" fact={total.окс_бфл} plan={план} unit="шт" bounds={bounds}
                was={было?.окс_бфл} big>
          <Split rows={rows} pick={t => t.окс_бфл} />
        </Metric>
        <Metric label="АЗ" fact={total.окс_аз} unit="шт" bounds={bounds} was={было?.окс_аз}>
          <Split rows={rows} pick={t => t.окс_аз} />
        </Metric>
        <Metric label="ВКИ" fact={total.окс_вки} unit="шт" bounds={bounds} was={было?.окс_вки}>
          <Split rows={rows} pick={t => t.окс_вки} />
        </Metric>
        {/* Темп сравнивается с месячным планом целиком, без доли дней: он и
            отвечает на вопрос «а к концу месяца хватит?». Развёртки у него
            нет намеренно — это не факт, а продолжение линии, и делить
            предсказание на источники значит придавать ему точность,
            которой в нём нет. */}
        <Metric
          label="Runrate" fact={rr} plan={план} unit="шт" additive={false}
          sub={rr === total.окс_бфл ? 'период закрыт' : 'при текущем темпе'}
        />
        {/* Квота отвечает на единственный вопрос, который остаётся после
            плана и факта: сколько надо делать начиная с сегодня. В отличие
            от нормы на графике она растёт с каждым отставанием, поэтому
            плана под ней нет — она сама и есть требование. */}
        <Metric
          label="Квота на день" fact={квота && квота.квота} unit="шт"
          sub={
            квота == null ? 'план не задан'
              : квота.дней === 0 ? 'период закрыт'
              : квота.осталось === 0 ? 'план выполнен'
              : `осталось ${formatNum(квота.осталось)} за ${formatNum(квота.дней)} ${plural(квота.дней, 'день', 'дня', 'дней')}`
          }
        />
      </div>

      <div className="rop-note">
        Договор оформляется отдельной карточкой, поэтому договоры периода относятся
        к встречам, которые были раньше. Делить одно на другое нельзя — это разные сделки.
      </div>

      <div className="fig-card">
        <div className="fig-card-t">Договоры БФЛ по дням</div>
        <div className="fig-card-s">
          заключено за день, штук; оранжевая линия — дневная норма (план ÷ дней в периоде)
        </div>
        <DailyPlan дни={ряд.дни} норма={ряд.норма} />
      </div>

      {!loading && !total.окс_бфл && !total.окс_аз && !total.окс_вки && (
        <div className="empty-state" style={{ marginTop: 20 }}>
          <div className="empty-state-icon">📭</div>
          <h3>За этот период договоров нет</h3>
          <p>Сделки загружены с 1 сентября 2026 года.</p>
        </div>
      )}
    </div>
  )
}
