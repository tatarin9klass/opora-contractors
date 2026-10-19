import React, { useEffect, useMemo, useState } from 'react'
import { todayISO } from '../lib/dateContext.js'
import {
  loadRopData, periodBounds, recentMonths, sumRows, avgCheck, brakShare,
  planFor, runRate, planStatus, paceTarget, stageMissing, formatMoneyShort, GROUPS,
} from '../lib/rop.js'
import { formatNum, plural } from '../lib/helpers.js'

// ============================================================================
// Общий дашборд отдела продаж: план против факта.
//
// ЧТО ЗДЕСЬ ГЛАВНОЕ ПО УСТРОЙСТВУ. Любой показатель раскрывается в развёртку
// на маркетинг и рекомендации — это главный разрез отдела: у заявки от
// агента, из отдела продаж или по рекомендации другой уровень лояльности, и
// доходимость отличается втрое. Смешивать их в одной цифре значит прятать
// самое содержательное, что в данных есть.
//
// ПЕРЕДАЧА В ОКС НЕ ДЕЛИТСЯ НА ВСТРЕЧИ. В Битриксе передача оформляется
// новой карточкой без истории встречи, поэтому передачи месяца относятся к
// встречам, которые были раньше. Соотношение этих двух чисел здесь не
// показывается — оно давало бы больше ста процентов и вводило бы в
// заблуждение. Подпись под блоком об этом прямо говорит.
// ============================================================================

const MODES = [
  { id: 'month', label: 'Месяц' },
  { id: 'week', label: 'Неделя' },
  { id: 'range', label: 'Период' },
]

function Metric({ label, fact, plan, unit, inverse, additive = true, bounds, sub, big, children }) {
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
          {inverse ? 'норма не выше ' : 'план '}
          {unit === '₽' ? formatMoneyShort(plan) : formatNum(plan)}{unit === '%' ? '%' : ''}
          {/* У метрики «не выше» доля от плана ничего не значит: 91% от
              нормы брака читается как недовыполнение, хотя это как раз
              хорошо. Поэтому для неё показывается расхождение в пунктах. */}
          {fact != null && plan > 0 && (inverse
            ? <span className="rop-metric-pct">
                {' · '}{fact > plan ? 'выше' : 'ниже'} нормы на{' '}
                {formatNum(Math.abs(Math.round((fact - plan) * 10) / 10))} п.п.
              </span>
            : <span className="rop-metric-pct"> · {Math.round((100 * fact) / plan)}%</span>
          )}
          {partial && (
            <span className="rop-metric-pct"> · к этому дню {formatNum(Math.round(target))}</span>
          )}
        </div>
      )}
      {sub && <div className="rop-metric-sub">{sub}</div>}
      {children}
    </div>
  )
}

function Split({ rows, pick, label }) {
  const total = GROUPS.reduce((a, g) => a + pick(sumRows(rows, g.id)), 0)
  return (
    <div className="rop-split">
      {GROUPS.map(g => {
        const v = pick(sumRows(rows, g.id))
        if (!v) return null
        return (
          <div key={g.id} className="rop-split-row">
            <span className={`rop-dot ${g.id === 'маркетинг' ? 'mk' : g.id === 'рекомендации' ? 'rec' : 'oth'}`} />
            <span className="rop-split-label">{g.label}</span>
            <span className="rop-split-value">{formatNum(v)}</span>
            <span className="rop-split-pct">{total ? Math.round((100 * v) / total) + '%' : ''}</span>
          </div>
        )
      })}
      {label && <div className="rop-split-note">{label}</div>}
    </div>
  )
}

export default function RopDashboardPage() {
  const [mode, setMode] = useState('month')
  const [anchor, setAnchor] = useState(todayISO())
  const [from, setFrom] = useState(todayISO())
  const [to, setTo] = useState(todayISO())
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [open, setOpen] = useState(null)

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
    return () => { cancelled = true }
  }, [bounds.from, bounds.to])

  const rows = data?.daily || []
  const plans = data?.plans || []
  const total = useMemo(() => sumRows(rows), [rows])
  const plan = (m) => planFor(plans, bounds.from, m)

  const чек = avgCheck(total)
  const брак = brakShare(total)
  const rr = runRate(total.окс_всего, bounds.from, bounds.to)

  const toggle = (key) => setOpen(prev => (prev === key ? null : key))

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

      {/* ---- Основное ---- */}
      <div className="portal-section-head">
        <h2 className="portal-section-title">Передано в ОКС</h2>
      </div>

      <div className="rop-metrics">
        <div onClick={() => toggle('окс')} style={{ cursor: 'pointer' }}>
          <Metric label="Все" fact={total.окс_всего} plan={plan('оксвсего')} unit="шт" bounds={bounds} big>
            {open === 'окс' && <Split rows={rows} pick={t => t.окс_всего} />}
          </Metric>
        </div>
        <div onClick={() => toggle('аз')} style={{ cursor: 'pointer' }}>
          <Metric label="АЗ" fact={total.окс_аз} plan={plan('оксаз')} unit="шт" bounds={bounds}>
            {open === 'аз' && <Split rows={rows} pick={t => t.окс_аз} />}
          </Metric>
        </div>
        <div onClick={() => toggle('вки')} style={{ cursor: 'pointer' }}>
          <Metric label="ВКИ" fact={total.окс_вки} plan={plan('оксвки')} unit="шт" bounds={bounds}>
            {open === 'вки' && <Split rows={rows} pick={t => t.окс_вки} />}
          </Metric>
        </div>
        {/* Темп сравнивается с месячным планом целиком, без доли дней: он
            и отвечает на вопрос «а к концу месяца хватит?». */}
        <Metric
          label="Runrate" fact={rr} plan={plan('оксвсего')} unit="шт" additive={false}
          sub={rr === total.окс_всего ? 'период закрыт' : 'при текущем темпе'}
        />
      </div>

      <div className="rop-note">
        Передача оформляется отдельной карточкой, поэтому передачи периода относятся
        к встречам, которые были раньше. Делить одно на другое нельзя — это разные сделки.
      </div>

      <div className="portal-section-head">
        <h2 className="portal-section-title">Встречи</h2>
      </div>
      <div className="rop-metrics">
        <div onClick={() => toggle('встречи')} style={{ cursor: 'pointer' }}>
          <Metric label="Проведено встреч" fact={total.встречи} plan={plan('встречи')} unit="шт" bounds={bounds} big>
            {open === 'встречи' && <Split rows={rows} pick={t => t.встречи} />}
          </Metric>
        </div>
      </div>

      {/* ---- Дополнительные ---- */}
      <div className="portal-section-head">
        <h2 className="portal-section-title">Дополнительно</h2>
        <p className="portal-section-note">
          Брак считается от проведённых встреч. Средний чек — из товарных позиций
          за вычетом ФПА, по сделкам, дошедшим до оформления.
        </p>
      </div>

      <div className="rop-metrics">
        <div onClick={() => toggle('брак')} style={{ cursor: 'pointer' }}>
          <Metric
            label="Брак" fact={брак == null ? null : Math.round(брак * 10) / 10}
            plan={plan('бракнорма')} unit="%" inverse additive={false}
            sub={`${formatNum(total.брак)} из ${formatNum(total.встречи)} ${plural(total.встречи, 'встречи', 'встреч', 'встреч')}`}
          >
            {open === 'брак' && <Split rows={rows} pick={t => t.брак} />}
          </Metric>
        </div>
        <Metric
          label="Средний чек" fact={чек} plan={plan('среднийчек')} unit="₽" additive={false}
          sub={`по ${formatNum(total.чек_сделок)} ${plural(total.чек_сделок, 'сделке', 'сделкам', 'сделкам')} с договором`}
        />
        <Metric
          label="ФПА" fact={total.фпа_сумма || null} unit="₽"
          sub="продаётся отдельно, в чек не входит"
        />
      </div>

      {!loading && !total.встречи && !total.окс_всего && (
        <div className="empty-state" style={{ marginTop: 20 }}>
          <div className="empty-state-icon">📭</div>
          <h3>За этот период данных нет</h3>
          <p>Сделки загружены с 1 сентября 2026 года.</p>
        </div>
      )}

      <div className="rop-footer">
        {(() => {
          const miss = stageMissing(data?.stageSince || [], 'оплата', bounds.from)
          return miss
            ? `Этап «Полная/частичная оплата» заведён ${miss.split('-').reverse().join('.')} — за более ранние дни по нему данных нет.`
            : null
        })()}
      </div>
    </div>
  )
}
