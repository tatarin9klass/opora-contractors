import React, { useState, useEffect, useMemo, useRef } from 'react'
import { LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, Legend, ResponsiveContainer } from 'recharts'
import { supabase, fetchAllRows } from '../lib/supabase.js'
import { weekStartOf } from '../lib/dateContext.js'

const FUNCTION_URL = 'https://jgmuuehxavwlrfkonnzx.supabase.co/functions/v1/bfl-timings'
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpnbXV1ZWh4YXZ3bHJma29ubnp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNzY4MzAsImV4cCI6MjA5NzY1MjgzMH0.BvX2ZBVSs17Vuwq_ok_e_QyAck0FG2yYTtuOkbaUrqU'

// Системный импорт начался 16 июля — раньше этой даты показывать нечего.
const MIN_WEEK = weekStartOf('2026-07-16')

const MAX_PASSES = 40

const CHARTS = [
  {
    metric: 'lead_to_qual',
    title: '1. Лид → квал',
    hint: 'Сколько времени проходит от создания лида до его квалификации. Замер относится к неделе квалификации.',
  },
  {
    metric: 'qual_to_meeting',
    usesMeetings: true,
    title: '2. Квал → встреча',
    hint: 'Сколько времени проходит от квалификации лида до проведённой встречи. Замер относится к неделе встречи.',
  },
  {
    metric: 'lead_to_meeting',
    usesMeetings: true,
    title: '3. Лид → встреча (сквозной)',
    hint: 'Полный путь от создания лида до проведённой встречи. Замер относится к неделе встречи.',
  },
]

function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7)
}

function weekLabel(iso) {
  return `${getISOWeek(new Date(iso))} нед`
}

export default function DependenciesPage({ isAdmin }) {
  const [rows, setRows] = useState([])
  const [coverage, setCoverage] = useState([])
  const [outcome, setOutcome] = useState([])
  const [retry, setRetry] = useState([])
  const [loading, setLoading] = useState(true)
  const [unit, setUnit] = useState('hours')
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)
  const cancelRef = useRef(false)

  async function load() {
    setLoading(true)
    try {
      const [data, cov, out, ret] = await Promise.all([
        fetchAllRows(() =>
          supabase.from('bfl_timing_weekly').select('*').gte('week_start', MIN_WEEK).order('week_start')),
        fetchAllRows(() =>
          supabase.from('bfl_timing_coverage').select('*').gte('week_start', MIN_WEEK).order('week_start')),
        fetchAllRows(() =>
          supabase.from('bfl_meeting_outcome_weekly').select('*').gte('week_start', MIN_WEEK).order('week_start')),
        fetchAllRows(() =>
          supabase.from('bfl_meeting_retry_weekly').select('*').gte('week_start', MIN_WEEK).order('week_start')),
      ])
      setRows(data)
      setCoverage(cov)
      setOutcome(out)
      setRetry(ret)
    } catch (e) {
      setError(String(e))
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  async function runSync() {
    setRunning(true)
    setError(null)
    cancelRef.current = false
    let leads = 0
    let meetings = 0
    try {
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        if (cancelRef.current) break
        const res = await fetch(FUNCTION_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ANON_KEY}`, 'apikey': ANON_KEY },
          body: JSON.stringify(pass === 0 ? { reset: true } : {}),
        })
        const json = await res.json().catch(() => null)
        if (!json || !json.success) {
          // Без статуса и тела такие сбои неотличимы друг от друга: упала
          // сама функция, отвалился шлюз или её убило по таймауту.
          const detail = json ? (json.error || JSON.stringify(json)) : 'пустой ответ'
          setError(`HTTP ${res.status}: ${detail}`)
          break
        }
        leads += json.leads_upserted || 0
        meetings += json.meetings_upserted || 0
        setProgress({ ...json, total_leads: leads, total_meetings: meetings, pass: pass + 1 })
        if (json.done) break
      }
      await load()
    } catch (e) {
      setError(String(e))
    }
    setRunning(false)
  }

  const factor = unit === 'hours' ? 1 : 24
  const unitLabel = unit === 'hours' ? 'ч' : 'дн'

  function fmt(v) {
    if (v == null) return '—'
    const val = v / factor
    return `${val.toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${unitLabel}`
  }

  // Общая ось недель на все три графика — чтобы они читались рядом и было
  // видно, совпадают ли скачки по времени.
  const weeks = useMemo(() => [...new Set(rows.map(r => r.week_start))].sort(), [rows])

  const byMetric = useMemo(() => {
    const out = {}
    for (const c of CHARTS) {
      const map = new Map(rows.filter(r => r.metric === c.metric).map(r => [r.week_start, r]))
      out[c.metric] = weeks.map(w => {
        const r = map.get(w)
        return {
          week: w,
          xLabel: weekLabel(w),
          avg: r ? Number(r.avg_hours) / factor : null,
          median: r ? Number(r.median_hours) / factor : null,
          p90: r ? Number(r.p90_hours) / factor : null,
          n: r ? r.n : 0,
        }
      })
    }
    return out
  }, [rows, weeks, factor])

  const covByWeek = useMemo(() => new Map(coverage.map(c => [c.week_start, c])), [coverage])

  // Итоги охвата за весь показанный период. Нужны, чтобы под графиком одной
  // строкой было видно, на какой доле встреч он вообще построен.
  const covTotals = useMemo(() => coverage.reduce((a, c) => ({
    total: a.total + (c.meetings_total || 0),
    measured: a.measured + (c.measured || 0),
    leadAfter: a.leadAfter + (c.lead_after_meeting || 0),
    missing: a.missing + (c.lead_missing || 0),
  }), { total: 0, measured: 0, leadAfter: 0, missing: 0 }), [coverage])

  // Доходимость: сколько назначенных встреч реально состоялось. Знаменатель —
  // только отработанные попытки, встречи «в работе» в него не идут, иначе
  // текущая неделя всегда выглядит провальной.
  const outcomeData = useMemo(() => outcome.map(o => ({
    week: o.week_start,
    xLabel: weekLabel(o.week_start),
    rate: o.rate == null ? null : Number(o.rate),
    scheduled: o.scheduled,
    held: o.held,
    failed: o.failed,
    pending: o.pending,
  })), [outcome])

  const outcomeTotals = useMemo(() => outcome.reduce((a, o) => ({
    held: a.held + (o.held || 0),
    failed: a.failed + (o.failed || 0),
    pending: a.pending + (o.pending || 0),
  }), { held: 0, failed: 0, pending: 0 }), [outcome])

  // Работа с сорвавшимися встречами: какую долю перезаписали и какая доля
  // перезаписанных в итоге дошла.
  const retryData = useMemo(() => retry.map(r => ({
    week: r.week_start,
    xLabel: weekLabel(r.week_start),
    retryRate: r.retry_rate == null ? null : Number(r.retry_rate),
    retrySuccess: r.retry_success_rate == null ? null : Number(r.retry_success_rate),
    failed: r.failed,
    retried: r.retried,
    retriedHeld: r.retried_held,
  })), [retry])

  // Если первый график данные дал, а второй пуст — значит встречи не удалось
  // связать с лидами. Это единственная неочевидная поломка в этой вкладке,
  // поэтому про неё говорим прямо, а не оставляем пустой график без объяснений.
  const hasLeadQual = rows.some(r => r.metric === 'lead_to_qual')
  const hasMeetingLink = rows.some(r => r.metric === 'qual_to_meeting')
  const linkBroken = hasLeadQual && !hasMeetingLink

  if (loading) return <div className="loading">Загрузка...</div>

  return (
    <div>
      <div className="info-card" style={{ marginBottom: 16 }}>
        <div className="info-card-title">Время между этапами воронки БФЛ</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 14 }}>
          Три замера по отчётным неделям (чт–ср), с 16 июля. Каждый замер относится к неделе
          <b> завершающего</b> события: «лид → квал» — к неделе квалификации, оба замера со встречей — к неделе встречи.
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <div style={{ display: 'flex', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 24, padding: 3 }}>
            {[['hours', 'Часы'], ['days', 'Дни']].map(([id, label]) => (
              <button key={id} onClick={() => setUnit(id)} style={{
                padding: '6px 16px', borderRadius: 20, border: 'none', fontSize: 13, fontWeight: 500, cursor: 'pointer',
                background: unit === id ? 'var(--green-dark)' : 'transparent',
                color: unit === id ? '#fff' : 'var(--text-secondary)',
              }}>{label}</button>
            ))}
          </div>
          {isAdmin && (
            <>
              <button className="btn btn-primary btn-sm" onClick={runSync} disabled={running}>
                {running ? 'Загружаем из Битрикса...' : '🔄 Обновить данные'}
              </button>
              {running && (
                <button className="btn btn-ghost btn-sm" onClick={() => { cancelRef.current = true }}>Остановить</button>
              )}
            </>
          )}
        </div>

        {error && <div className="alert alert-danger" style={{ marginTop: 12 }}>🔴 {error}</div>}

        {progress && (
          <div className={`alert ${progress.done ? 'alert-info' : 'alert-warning'}`} style={{ marginTop: 12 }}>
            {progress.done
              ? `✅ Готово. Лидов: ${progress.total_leads}, встреч: ${progress.total_meetings}.`
              : `⏳ Идёт загрузка (${progress.phase === 'leads' ? 'лиды' : 'встречи'})… проход ${progress.pass}, записано лидов ${progress.total_leads}, встреч ${progress.total_meetings}.`}
          </div>
        )}

        {progress?.meeting_fields_sample?.length > 0 && (
          <div className="alert alert-danger" style={{ marginTop: 12 }}>
            Не удалось найти у встречи ссылку на лид, поэтому графики 2 и 3 останутся пустыми.
            Поля встречи: <code style={{ fontSize: 11 }}>{progress.meeting_fields_sample.join(', ')}</code> — пришли этот список, допишу связь.
          </div>
        )}

        {linkBroken && !progress && (
          <div className="alert alert-warning" style={{ marginTop: 12 }}>
            ⚠️ По встречам замеров нет — похоже, встречи не связаны с лидами. Нажми «Обновить данные»: импорт покажет, какими полями встреча связана с чем.
          </div>
        )}
      </div>

      {rows.length === 0 ? (
        <div className="empty-state" style={{ marginTop: 40 }}>
          <div className="empty-state-icon">⏱</div>
          <h3>Данных пока нет</h3>
          <p style={{ maxWidth: 420, margin: '8px auto 0' }}>
            {isAdmin
              ? 'Нажми «Обновить данные» — это разовая загрузка истории из Битрикса, занимает несколько минут.'
              : 'Историю ещё не загрузили. Обратитесь к администратору.'}
          </p>
        </div>
      ) : CHARTS.map(c => {
        const data = byMetric[c.metric] || []
        const hasAny = data.some(d => d.avg != null)
        return (
          <div key={c.metric} style={{ background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 20, marginBottom: 16 }}>
            <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>{c.title}</div>
            <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>{c.hint}</div>

            {!hasAny ? (
              <div style={{ textAlign: 'center', padding: '40px 0', color: 'var(--text-muted)', fontSize: 13 }}>Нет данных</div>
            ) : (
              <>
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={data} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#dce8d8" />
                    <XAxis dataKey="xLabel" tick={{ fontSize: 11, fill: '#8a9590' }} />
                    <YAxis tick={{ fontSize: 11, fill: '#8a9590' }} width={45} />
                    <Tooltip
                      formatter={(v, name) => [v == null ? '—' : `${Number(v).toLocaleString('ru-RU', { maximumFractionDigits: 1 })} ${unitLabel}`, name]}
                      labelFormatter={(label, payload) => {
                        const n = payload?.[0]?.payload?.n
                        return `${label}${n ? ` · выборка ${n}` : ''}`
                      }}
                    />
                    <Legend wrapperStyle={{ fontSize: 12 }} />
                    <Line type="monotone" dataKey="median" name="Медиана" stroke="#3A7E34" strokeWidth={2} dot={{ r: 3 }} connectNulls />
                    <Line type="monotone" dataKey="avg" name="Среднее" stroke="#1f3b27" strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3 }} connectNulls />
                    <Line type="monotone" dataKey="p90" name="90-й перцентиль" stroke="#c9a227" strokeWidth={1.5} dot={false} connectNulls />
                  </LineChart>
                </ResponsiveContainer>

                <div style={{ overflowX: 'auto', marginTop: 10 }}>
                  <table className="table-compact">
                    <thead>
                      <tr>
                        <th>Неделя</th>
                        {data.map(d => <th key={d.week} style={{ textAlign: 'right' }}>{d.xLabel}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      <tr>
                        <td>Медиана</td>
                        {data.map(d => <td key={d.week} style={{ textAlign: 'right' }}>{d.median == null ? '—' : `${d.median.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}`}</td>)}
                      </tr>
                      <tr>
                        <td>Среднее</td>
                        {data.map(d => <td key={d.week} style={{ textAlign: 'right' }}>{d.avg == null ? '—' : `${d.avg.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}`}</td>)}
                      </tr>
                      <tr>
                        <td className="td-muted">Выборка</td>
                        {data.map(d => <td key={d.week} style={{ textAlign: 'right' }} className="td-muted">{d.n || '—'}</td>)}
                      </tr>
                      {c.usesMeetings && (
                        <tr>
                          <td className="td-muted">Охват</td>
                          {data.map(d => {
                            const cv = covByWeek.get(d.week)
                            return (
                              <td key={d.week} style={{ textAlign: 'right' }} className="td-muted">
                                {cv ? `${cv.measured}/${cv.meetings_total}` : '—'}
                              </td>
                            )
                          })}
                        </tr>
                      )}
                    </tbody>
                  </table>
                </div>

                {c.usesMeetings && covTotals.total > 0 && (
                  <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
                    Охват — сколько встреч недели вообще поддаётся замеру. За весь период измерено{' '}
                    <b>{covTotals.measured} из {covTotals.total}</b> встреч БФЛ
                    {' '}({Math.round(covTotals.measured / covTotals.total * 100)}%).
                    Выпадают те, где лид заведён уже после встречи ({covTotals.leadAfter}) — время до
                    несуществующего лида измерить нельзя. Чаще всего так у источников со «ЗВ» в названии:
                    позвонили, встретились, лид завели потом.
                  </div>
                )}
              </>
            )}
          </div>
        )
      })}

      {outcomeData.length > 0 && (
        <div style={{ background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 20, marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>4. Доходимость встреч</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
            Какая доля назначенных встреч реально состоялась. Неделя — по плановому времени встречи,
            то есть каждая попытка засчитывается в ту неделю, на которую её назначали.
          </div>

          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={outcomeData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#dce8d8" />
              <XAxis dataKey="xLabel" tick={{ fontSize: 11, fill: '#8a9590' }} />
              <YAxis tick={{ fontSize: 11, fill: '#8a9590' }} width={45} domain={[0, 100]} unit="%" />
              <Tooltip
                formatter={v => [v == null ? '—' : `${v}%`, 'Доходимость']}
                labelFormatter={(label, payload) => {
                  const d = payload?.[0]?.payload
                  if (!d) return label
                  return `${label} · состоялось ${d.held} из ${d.held + d.failed}${d.pending ? `, в работе ${d.pending}` : ''}`
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="rate" name="Доходимость, %" stroke="#3A7E34" strokeWidth={2} dot={{ r: 3 }} connectNulls />
            </LineChart>
          </ResponsiveContainer>

          <div style={{ overflowX: 'auto', marginTop: 10 }}>
            <table className="table-compact">
              <thead>
                <tr>
                  <th>Неделя</th>
                  {outcomeData.map(d => <th key={d.week} style={{ textAlign: 'right' }}>{d.xLabel}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td>Доходимость</td>
                  {outcomeData.map(d => <td key={d.week} style={{ textAlign: 'right' }}>{d.rate == null ? '—' : `${d.rate}%`}</td>)}
                </tr>
                <tr>
                  <td className="td-muted">Состоялось</td>
                  {outcomeData.map(d => <td key={d.week} style={{ textAlign: 'right' }} className="td-muted">{d.held}</td>)}
                </tr>
                <tr>
                  <td className="td-muted">Сорвалось</td>
                  {outcomeData.map(d => <td key={d.week} style={{ textAlign: 'right' }} className="td-muted">{d.failed}</td>)}
                </tr>
                <tr>
                  <td className="td-muted">В работе</td>
                  {outcomeData.map(d => <td key={d.week} style={{ textAlign: 'right' }} className="td-muted">{d.pending || '—'}</td>)}
                </tr>
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            За весь период: состоялось <b>{outcomeTotals.held}</b>, сорвалось <b>{outcomeTotals.failed}</b>
            {outcomeTotals.pending > 0 && <>, ещё в работе {outcomeTotals.pending}</>} —
            доходимость{' '}
            <b>{Math.round(outcomeTotals.held / (outcomeTotals.held + outcomeTotals.failed) * 100)}%</b>.
            На каждое назначение в Битриксе заводится отдельная запись, поэтому считаются попытки:
            один лид, которому встречу переназначали трижды, даёт три попытки и максимум одну состоявшуюся.
            «В работе» — встречи с датой в будущем, в знаменатель они не идут.
          </div>
        </div>
      )}

      {retryData.length > 0 && (
        <div style={{ background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 20, marginBottom: 16 }}>
          <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>5. Работа с сорвавшимися встречами</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 14 }}>
            Из встреч, сорвавшихся на этой неделе, какой доле назначили новую — и какая доля тех в итоге состоялась.
            Неделя — по времени сорвавшейся встречи.
          </div>

          <ResponsiveContainer width="100%" height={260}>
            <LineChart data={retryData} margin={{ top: 5, right: 20, left: 0, bottom: 5 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#dce8d8" />
              <XAxis dataKey="xLabel" tick={{ fontSize: 11, fill: '#8a9590' }} />
              <YAxis tick={{ fontSize: 11, fill: '#8a9590' }} width={45} domain={[0, 100]} unit="%" />
              <Tooltip
                formatter={(v, name) => [v == null ? '—' : `${v}%`, name]}
                labelFormatter={(label, payload) => {
                  const d = payload?.[0]?.payload
                  if (!d) return label
                  return `${label} · сорвалось ${d.failed}, перезаписали ${d.retried}, дошли ${d.retriedHeld}`
                }}
              />
              <Legend wrapperStyle={{ fontSize: 12 }} />
              <Line type="monotone" dataKey="retryRate" name="Перезаписали, %" stroke="#3A7E34" strokeWidth={2} dot={{ r: 3 }} connectNulls />
              <Line type="monotone" dataKey="retrySuccess" name="Из них дошли, %" stroke="#c9a227" strokeWidth={2} strokeDasharray="5 4" dot={{ r: 3 }} connectNulls />
            </LineChart>
          </ResponsiveContainer>

          <div style={{ overflowX: 'auto', marginTop: 10 }}>
            <table className="table-compact">
              <thead>
                <tr>
                  <th>Неделя</th>
                  {retryData.map(d => <th key={d.week} style={{ textAlign: 'right' }}>{d.xLabel}</th>)}
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td className="td-muted">Сорвалось</td>
                  {retryData.map(d => <td key={d.week} style={{ textAlign: 'right' }} className="td-muted">{d.failed}</td>)}
                </tr>
                <tr>
                  <td>Перезаписали</td>
                  {retryData.map(d => <td key={d.week} style={{ textAlign: 'right' }}>{d.retried}</td>)}
                </tr>
                <tr>
                  <td className="td-muted">Из них дошли</td>
                  {retryData.map(d => <td key={d.week} style={{ textAlign: 'right' }} className="td-muted">{d.retriedHeld}</td>)}
                </tr>
              </tbody>
            </table>
          </div>

          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 8 }}>
            Последние одна-две недели всегда занижены: перезаписать сорвавшуюся встречу ещё просто не успели.
            Смотреть тренд имеет смысл по неделям постарше.
          </div>
        </div>
      )}

      {rows.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
          Значения в таблицах — в тех же единицах, что выбраны переключателем ({unitLabel}).
          Медиана устойчива к выбросам, среднее — нет: если они разъезжаются, неделю испортила пара
          аномально долгих лидов, а не процесс целиком. 90-й перцентиль показывает, где сидит этот хвост.
        </div>
      )}
    </div>
  )
}
