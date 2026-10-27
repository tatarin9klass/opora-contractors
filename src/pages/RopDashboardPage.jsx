import React, { useEffect, useMemo, useState } from 'react'
import { todayISO } from '../lib/dateContext.js'
import {
  loadRopData, periodBounds, recentMonths, sumRows, avgCheck, brakShare,
  planFor, runRate, planStatus, paceTarget, stageMissing, formatMoneyShort, GROUPS, byTeam,
  prevBounds, dailySeries, quotaPerDay, loadDeals, loadLost,
} from '../lib/rop.js'
import { formatNum, plural } from '../lib/helpers.js'

// ============================================================================
// Общий дашборд отдела продаж: план против факта.
//
// ЧТО ЗДЕСЬ ГЛАВНОЕ ПО УСТРОЙСТВУ. Под каждым показателем стоит развёртка на
// маркетинг и рекомендации, и стоит всегда, без раскрытия по клику. Это
// главный разрез отдела: у заявки от агента, из отдела продаж или по
// рекомендации другой уровень лояльности, и доходимость отличается втрое.
// Смешивать их в одной цифре значит прятать самое содержательное, что в
// данных есть, а прятать за кликом — делать вид, что итог самодостаточен.
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
      {/* «Было» рядом с цифрой отвечает на вопрос, который иначе остаётся
          без ответа: двадцать восемь передач — это много или мало. Без
          прошлого периода любая метрика читается как нейтральная. */}
      {was != null && fact != null && (
        <div className="rop-metric-was">
          было {unit === '₽' ? formatMoneyShort(was) : formatNum(was)}{unit === '%' ? '%' : ''}
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
// Прятать главный разрез за взаимодействием значит делать вид, что итог
// самодостаточен — а он не самодостаточен ни в одной строке этого экрана.
//
// Маркетинг и рекомендации показываются всегда, даже нулём: так карточки не
// прыгают по высоте от периода к периоду. «Прочее» появляется, только когда
// в нём что-то есть, — пустая строка в каждой плитке отвлекала бы.
//
// kind решает, как читать число. Доли считаются только для количеств: у
// среднего чека доля от суммы средних не значит ничего, а у доли брака
// складывать проценты групп просто нельзя.

// Договоры по дням против дневной нормы.
//
// ПОЧЕМУ СТОЛБИКИ, А НЕ ЛИНИЯ. Договор — событие, а не измерение. Линия,
// протянутая между вторником и четвергом, обещает, что в среду было
// что-то среднее, хотя в среду не было ничего. Столбик показывает ровно
// то, что случилось в этот день, и пустой день выглядит пустым.
//
// ЛИНИЯ НОРМЫ ГОРИЗОНТАЛЬНА — это план, разложенный на дни поровну. Она не
// прогноз, а линейка: по ней видно, какие дни вытягивают месяц, а какие
// проваливают, не считая ничего в уме.
//
// Чего этот график не показывает — отставания накопленным итогом. За этим
// стоит плитка «Квота на день»: она и говорит, сколько надо делать дальше.
function DailyPlan({ дни, норма }) {
  const W = 760, H = 210, L = 34, R = 46, T = 18, B = 30
  const n = дни.length
  const hi = Math.max(норма || 0, ...дни.map(d => d.факт || 0), 1)
  const top = hi * 1.2
  const bw = (W - L - R) / Math.max(1, n)
  const X = i => L + bw * i
  const Y = v => T + (H - T - B) - ((H - T - B) * v) / top

  // Деления только целые: половины договоров не бывает.
  const step = Math.max(1, Math.ceil(hi / 4))
  const ticks = []
  for (let v = 0; v <= hi; v += step) ticks.push(v)

  // Подписи дат не на каждый столбик: за месяц они слипаются. Шаг
  // подбирается так, чтобы подписей вышло около восьми.
  const шаг = Math.max(1, Math.round(n / 8))
  const dd = iso => iso.slice(8) + '.' + iso.slice(5, 7)

  // Ширина столбика ограничена сверху: на периоде в один-два дня доля от
  // полосы дала бы плиту в треть экрана, и один договор выглядел бы как
  // достижение месяца.
  const ш = Math.max(1.5, Math.min(30, bw * 0.64))

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" className="rop-burnup">
      {ticks.map(v => (
        <g key={v}>
          <line x1={L} y1={Y(v)} x2={W - R} y2={Y(v)} stroke="#e4ebe2" />
          <text x={L - 6} y={Y(v) + 3.5} fontSize="9.5" fill="#6b7670" textAnchor="end">{v}</text>
        </g>
      ))}
      <text x={L - 6} y={T - 6} fontSize="9" fill="#6b7670" textAnchor="end">шт</text>

      {дни.map((d, i) => (d.факт ? (
        <g key={d.дата}>
          <rect x={X(i) + (bw - ш) / 2} y={Y(d.факт)} width={ш}
                height={Math.max(1, Y(0) - Y(d.факт))} rx="1.5" fill="#1f6f3f" />
          <text x={X(i) + bw / 2} y={Y(d.факт) - 4} fontSize="9" fontWeight="600"
                fill="#1a1f1c" textAnchor="middle">{d.факт}</text>
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
        <text key={d.дата} x={X(i) + bw / 2} y={H - 8} fontSize="8.5" fill="#6b7670"
              textAnchor="middle">{dd(d.дата)}</text>
      ) : null))}
    </svg>
  )
}

function Split({ rows, pick, kind = 'count' }) {
  const vals = GROUPS.map(g => ({ g, v: pick(sumRows(rows, g.id)) }))
  const shown = vals.filter(x => x.g.id !== 'прочее' || x.v)
  if (!shown.some(x => x.v)) return null
  const total = kind === 'count' ? vals.reduce((a, x) => a + (x.v || 0), 0) : 0

  const fmt = (v) => {
    if (v == null || (kind !== 'count' && !v)) return '—'
    if (kind === 'money') return formatMoneyShort(v)
    if (kind === 'pct') return formatNum(Math.round(v * 10) / 10) + '%'
    return formatNum(v)
  }

  return (
    <div className="rop-split">
      {shown.map(({ g, v }) => (
        <div key={g.id} className="rop-split-row">
          <span className={`rop-dot ${g.id === 'маркетинг' ? 'mk' : g.id === 'рекомендации' ? 'rec' : 'oth'}`} />
          <span className="rop-split-label">{g.label}</span>
          <span className="rop-split-value">{fmt(v)}</span>
          <span className="rop-split-pct">
            {kind === 'count' && total ? Math.round((100 * (v || 0)) / total) + '%' : ''}
          </span>
        </div>
      ))}
    </div>
  )
}

export default function RopDashboardPage({ team = null }) {
  const [mode, setMode] = useState('month')
  const [anchor, setAnchor] = useState(todayISO())
  const [from, setFrom] = useState(todayISO())
  const [to, setTo] = useState(todayISO())
  const [data, setData] = useState(null)
  const [prev, setPrev] = useState(null)
  const [pace, setPace] = useState(null)
  const [lost, setLost] = useState(null)
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
    loadLost(bounds.from, bounds.to)
      .then(l => { if (!cancelled) setLost(l) })
      .catch(() => { if (!cancelled) setLost([]) })

    const pb = prevBounds(mode, bounds.from, bounds.to)
    loadRopData(pb.from, pb.to)
      .then(d => { if (!cancelled) setPrev(d) })
      .catch(() => { if (!cancelled) setPrev(null) })
    return () => { cancelled = true }
  }, [bounds.from, bounds.to, mode])

  useEffect(() => {
    let cancelled = false
    loadDeals().then(d => { if (!cancelled) setPace(d.pace) }).catch(() => {})
    return () => { cancelled = true }
  }, [])

  const rows = byTeam(data?.daily || [], team)
  const plans = data?.plans || []
  const total = useMemo(() => sumRows(rows), [rows])
  const plan = (m) => planFor(plans, bounds.from, m, null, team)

  const было = useMemo(
    () => (prev ? sumRows(byTeam(prev.daily || [], team)) : null),
    [prev, team],
  )
  const чек = avgCheck(total)
  const брак = brakShare(total)
  // Темп и квота считаются от договоров БФЛ: это та цифра, на которую
  // заведён план. Окс_всего остаётся в данных, но план-факт по нему больше
  // не строится — в нём смешаны БФЛ, АЗ и ВКИ, а продаются они порознь.
  const rr = runRate(total.окс_бфл, bounds.from, bounds.to)
  const квота = quotaPerDay(plan('оксвсего'), total.окс_бфл, bounds.to)
  const ряд = dailySeries(rows, bounds.from, bounds.to, plan('оксвсего'))

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
        <h2 className="portal-section-title">Заключённые договоры</h2>
      </div>

      <div className="rop-metrics">
        {/* БФЛ опознаётся по депозиту АУ среди позиций сделки, а не по
            названию услуги: реструктуризация — тоже банкротство, и депозит
            у неё тоже есть. АЗ и ВКИ продаются поверх договора, поэтому
            сделка может попасть и в БФЛ, и в АЗ — три плитки намеренно не
            складываются в одну сумму. */}
        <Metric label="БФЛ" fact={total.окс_бфл} plan={plan('оксвсего')} unit="шт" bounds={bounds}
                was={было?.окс_бфл} big>
          <Split rows={rows} pick={t => t.окс_бфл} />
        </Metric>
        <Metric label="АЗ" fact={total.окс_аз} plan={plan('оксаз')} unit="шт" bounds={bounds} was={было?.окс_аз}>
          <Split rows={rows} pick={t => t.окс_аз} />
        </Metric>
        <Metric label="ВКИ" fact={total.окс_вки} plan={plan('оксвки')} unit="шт" bounds={bounds} was={было?.окс_вки}>
          <Split rows={rows} pick={t => t.окс_вки} />
        </Metric>
        {/* Темп сравнивается с месячным планом целиком, без доли дней: он и
            отвечает на вопрос «а к концу месяца хватит?». Развёртки у него
            нет намеренно — это не факт, а продолжение линии, и делить
            предсказание на источники значит придавать ему точность,
            которой в нём нет. */}
        <Metric
          label="Runrate" fact={rr} plan={plan('оксвсего')} unit="шт" additive={false}
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
          столбики — заключено за день, штук; оранжевая линия — дневная норма (план ÷ дней в периоде)
        </div>
        <DailyPlan дни={ряд.дни} норма={ряд.норма} />
      </div>

      <div className="portal-section-head">
        <h2 className="portal-section-title">Встречи</h2>
      </div>
      <div className="rop-metrics">
        <Metric label="Проведено встреч" fact={total.встречи} plan={plan('встречи')} unit="шт" bounds={bounds}
                was={было?.встречи} big>
          <Split rows={rows} pick={t => t.встречи} />
        </Metric>
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
        <Metric
          label="Брак" fact={брак == null ? null : Math.round(брак * 10) / 10}
          plan={plan('бракнорма')} unit="%" inverse additive={false}
          sub={`${formatNum(total.брак)} из ${formatNum(total.встречи)} ${plural(total.встречи, 'встречи', 'встреч', 'встреч')}`}
        >
          {/* В развёртке доля брака внутри каждой группы, а не дележ 29
              штук на две части. Вопрос у руководителя не «откуда брак», а
              «где бракуют чаще», и на него отвечают только проценты. */}
          <Split rows={rows} kind="pct"
                 pick={t => (t.встречи ? (100 * t.брак) / t.встречи : null)} />
        </Metric>
        <Metric
          label="Средний чек" fact={чек} plan={plan('среднийчек')} unit="₽" additive={false}
          was={было && было.чек_сделок ? Math.round(было.чек_сумма / было.чек_сделок) : undefined}
          sub={`по ${formatNum(total.чек_сделок)} ${plural(total.чек_сделок, 'сделке', 'сделкам', 'сделкам')} с договором`}
        >
          <Split rows={rows} kind="money" pick={t => avgCheck(t)} />
        </Metric>
        <Metric
          label="ФПА" fact={total.фпа_сумма || null} unit="₽"
          sub="продаётся отдельно, в чек не входит"
        >
          <Split rows={rows} kind="money" pick={t => t.фпа_сумма} />
        </Metric>
      </div>

      {!loading && !total.встречи && !total.окс_всего && (
        <div className="empty-state" style={{ marginTop: 20 }}>
          <div className="empty-state-icon">📭</div>
          <h3>За этот период данных нет</h3>
          <p>Сделки загружены с 1 сентября 2026 года.</p>
        </div>
      )}

      {lost && lost.length > 0 && (() => {
        const свои = byTeam(lost, team)
        const по = new Map()
        let всего = 0, безПричины = 0
        for (const r of свои) {
          const n = Number(r.сделок || 0)
          всего += n
          if (r.без_причины) безПричины += n
          по.set(r.причина, (по.get(r.причина) || 0) + n)
        }
        if (!всего) return null
        const список = [...по.entries()].sort((a, b) => b[1] - a[1])
        return (
          <>
            <div className="portal-section-head">
              <h2 className="portal-section-title">Потери и их причины</h2>
              <p className="portal-section-note">
                Отдельного поля «причина отказа» в воронке нет — причиной
                служит стадия, на которой сделка закрылась. Поэтому «Встреча:
                брак» это не причина, а её отсутствие: по таким сделкам потом
                не восстановить, что произошло.
              </p>
            </div>
            {безПричины > 0 && (
              <div className="rop-alert">
                <b>{formatNum(безПричины)}</b> из {formatNum(всего)}{' '}
                {plural(всего, 'потери', 'потерь', 'потерь')} закрыты без указания
                причины — это {Math.round((100 * безПричины) / всего)}%. Пока сделка
                уходит в общую корзину, разговаривать с менеджером не о чем: сводка
                есть, повода нет.
              </div>
            )}
            <div className="rop-loss">
              {список.map(([причина, n]) => (
                <div key={причина} className="rop-loss-row">
                  <span className="rop-loss-name">{причина}</span>
                  <span className="rop-loss-bar">
                    <span className={`rop-loss-fill ${причина.includes('брак') ? 'bad' : ''}`}
                          style={{ width: `${Math.round((100 * n) / всего)}%` }} />
                  </span>
                  <span className="rop-loss-n">{formatNum(n)}</span>
                  <span className="rop-loss-pct">{Math.round((100 * n) / всего)}%</span>
                </div>
              ))}
            </div>
          </>
        )
      })()}

      {pace && pace.length > 0 && (
        <>
          <div className="portal-section-head">
            <h2 className="portal-section-title">Скорость этапов</h2>
            <p className="portal-section-note">
              Сколько дней сделка проводит на этапе, прежде чем уйти дальше.
              Конверсия говорит, сколько дошло; скорость — почему медленно, и
              ею руководитель управляет напрямую. Порог застоя в портфеле
              берётся отсюда же: это срок, за который этап отпускает восемь
              сделок из десяти.
            </p>
          </div>
          <div className="table-wrap">
            <table className="table-compact rop-table">
              <thead>
                <tr>
                  <th>Этап</th>
                  <th>Переходов</th>
                  <th>Медиана, дней</th>
                  <th>Восемь из десяти уходят за</th>
                  <th>Доходят до ОКС</th>
                </tr>
              </thead>
              <tbody>
                {[...pace].sort((a, b) => b.переходов - a.переходов).map(p => (
                  <tr key={p.stage_id}>
                    <td>{p.этап || p.stage_id}</td>
                    <td className="portal-num">{formatNum(p.переходов)}</td>
                    <td className="portal-num">{formatNum(p.медиана_дней)}</td>
                    <td className="portal-num">{formatNum(p.дней_у_80_процентов)}</td>
                    <td className="portal-num">
                      {p.доля_дошедших == null
                        ? <span className="td-muted">мало истории</span>
                        : <b>{formatNum(p.доля_дошедших)}%</b>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
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
