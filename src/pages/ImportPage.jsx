import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatDate } from '../lib/helpers.js'
import { computeDateContext } from '../lib/dateContext.js'

const FUNCTION_URL = 'https://jgmuuehxavwlrfkonnzx.supabase.co/functions/v1/bitrix-import'
const ROP_FUNCTION_URL = 'https://jgmuuehxavwlrfkonnzx.supabase.co/functions/v1/rop-deals'
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpnbXV1ZWh4YXZ3bHJma29ubnp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNzY4MzAsImV4cCI6MjA5NzY1MjgzMH0.BvX2ZBVSs17Vuwq_ok_e_QyAck0FG2yYTtuOkbaUrqU'

const DAY_NAMES = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']

export default function ImportPage() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [unmatchedList, setUnmatchedList] = useState([])
  const [contractors, setContractors] = useState([])
  const [frozenWeeks, setFrozenWeeks] = useState(new Set())
  const [sourceLabels, setSourceLabels] = useState({})
  const [ropLoading, setRopLoading] = useState(false)
  const [ropResult, setRopResult] = useState(null)
  const [ropError, setRopError] = useState(null)

  // computeDateContext() пересчитывается не только при монтировании, но и при
  // возврате фокуса на вкладку — чтобы "сегодня" не залипало, если вкладка
  // была открыта дольше суток (см. docs/TZ.md, раздел 2).
  const [ctx, setCtx] = useState(() => computeDateContext())
  const [selectedDate, setSelectedDate] = useState(ctx.todayISO)

  useEffect(() => {
    function refreshDateContext() {
      if (document.visibilityState !== 'visible') return
      const next = computeDateContext()
      setCtx(prev => {
        if (prev.todayISO === next.todayISO) return prev
        setSelectedDate(sel => (sel === prev.todayISO ? next.todayISO : sel))
        return next
      })
    }
    document.addEventListener('visibilitychange', refreshDateContext)
    window.addEventListener('focus', refreshDateContext)
    return () => {
      document.removeEventListener('visibilitychange', refreshDateContext)
      window.removeEventListener('focus', refreshDateContext)
    }
  }, [])

  async function loadUnmatched() {
    const { data } = await supabase.from('unmatched_sources').select('*').is('linked_contractor_id', null).order('total_leads', { ascending: false })
    setUnmatchedList(data || [])
  }

  useEffect(() => {
    loadUnmatched()
    supabase.from('contractors').select('id, name, short_name').order('name').then(({ data }) => setContractors(data || []))
    // ТЗ раздел 3: замороженная неделя выпадает из редактируемого окна импорта.
    supabase.from('weekly_snapshots').select('week_start').then(({ data }) => {
      setFrozenWeeks(new Set((data || []).map(r => r.week_start)))
    })
    // Для читаемого отображения результата синка расхода из Google Таблиц
    // (bitrix-import отдаёт только source_id, без имени).
    supabase.from('sources').select('id, name, contractors(short_name, name)').then(({ data }) => {
      const map = {}
      ;(data || []).forEach(s => {
        map[s.id] = `${s.contractors?.short_name || s.contractors?.name || '—'} · ${s.name}`
      })
      setSourceLabels(map)
    })
  }, [])

  async function runImport(dateOverride) {
    const dateToUse = dateOverride || selectedDate
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch(FUNCTION_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ANON_KEY}`, 'apikey': ANON_KEY },
        body: JSON.stringify({ date: dateToUse }),
      })
      const json = await res.json()
      if (!json.success) {
        setError(json.error || 'Неизвестная ошибка')
      } else {
        setResult(json)
        loadUnmatched()
      }
    } catch (e) {
      setError(String(e))
    }
    setLoading(false)
  }

  // --------------------------------------------------------------------------
  // Сделки отдела продаж.
  //
  // ЗАГРУЗКА ИДЁТ НЕСКОЛЬКИМИ ПРОХОДАМИ, И ЭТО НЕ КОСТЫЛЬ. Функция живёт
  // ограниченное время, а воронка — это шестьсот сделок, у каждой товарные
  // позиции и история этапов: три запроса на сделку. Поэтому функция
  // запоминает, где остановилась, и следующий вызов продолжает с того же
  // места. Кнопка сама ходит, пока не получит done.
  //
  // КАЖДЫЙ ЗАПУСК ЧИТАЕТ ВОРОНКУ ЗАНОВО, с 1 сентября. Догружать только
  // новые сделки нельзя: этап, сумма и состав услуг меняются всю жизнь
  // сделки, и воронка застыла бы в том виде, в каком её увидели впервые.
  // --------------------------------------------------------------------------
  const ROP_PHASES = {
    deals: 'сделки', products: 'состав услуг', stages: 'история этапов', idle: 'готово',
  }

  async function runRopImport() {
    setRopLoading(true)
    setRopError(null)
    setRopResult(null)
    try {
      let body = { reset: true }
      // Счётчики в ответе — за один проход, а не за всю загрузку: функция о
      // предыдущих вызовах не знает. Складываем здесь, иначе на экране будет
      // последний кусок вместо итога.
      const totals = { deals: 0, products: 0, stages: 0 }
      for (let pass = 1; pass <= 20; pass++) {
        const res = await fetch(ROP_FUNCTION_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ANON_KEY}`, 'apikey': ANON_KEY },
          body: JSON.stringify(body),
        })
        const json = await res.json()
        if (!json.success) { setRopError(json.error || 'Неизвестная ошибка'); break }
        totals.deals += Number(json.deals_upserted || 0)
        totals.products += Number(json.products_upserted || 0)
        totals.stages += Number(json.stages_upserted || 0)
        setRopResult({ ...json, pass, totals: { ...totals } })
        if (json.done) break
        body = {}
      }
    } catch (e) {
      setRopError(String(e))
    }
    setRopLoading(false)
  }

  async function linkSource(unmatchedId, sourceMarker, contractorId) {
    if (!contractorId) return
    const { data: newSource } = await supabase.from('sources').insert({
      contractor_id: contractorId, name: sourceMarker, roistat_marker: sourceMarker, status: 'активен',
    }).select().single()
    await supabase.from('daily_facts').update({ contractor_id: contractorId, source_id: newSource.id }).eq('source_marker', sourceMarker)
    await supabase.from('unmatched_sources').update({ linked_contractor_id: contractorId }).eq('id', unmatchedId)
    loadUnmatched()
  }

  function dayOptionLabel(d, isPrevWeekSection) {
    const dateObj = new Date(d + 'T00:00:00')
    const isToday = d === ctx.todayISO
    return `${DAY_NAMES[dateObj.getDay()]} ${formatDate(d)}${isToday ? ' (сегодня)' : ''}${isPrevWeekSection ? ' · прошлая неделя' : ''}`
  }

  // ТЗ раздел 3: как только неделя заморожена — она выпадает из
  // редактируемого окна импорта, независимо от дня недели.
  const editableCurrentWeekDays = frozenWeeks.has(ctx.currentWeekThuISO) ? [] : ctx.currentWeekDays
  const editablePreviousWeekDays = (ctx.previousWeekDays.length > 0 && frozenWeeks.has(ctx.previousWeekDays[0])) ? [] : ctx.previousWeekDays

  return (
    <div>
      <div className="info-card" style={{ maxWidth: 760, marginBottom: 16 }}>
        <div className="info-card-title">Импорт данных из Битрикс24</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
          Подтягивает лиды, квалы, встречи и сделки за выбранный день и распределяет их по подрядчикам через
          roistat-маркер источника. Расход вводится отдельно вручную.
        </div>

        {ctx.isThursday && (
          <div className="alert alert-info">
            📅 Сегодня четверг — доступна вся только что закрывшаяся предыдущая неделя для перепроверки, помимо текущей.
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
          <select className="form-select" value={selectedDate} onChange={e => setSelectedDate(e.target.value)}>
            <optgroup label="Текущая неделя">
              {editableCurrentWeekDays.map(d => (
                <option key={d} value={d}>{dayOptionLabel(d, false)}</option>
              ))}
            </optgroup>
            {editablePreviousWeekDays.length > 0 && (
              <optgroup label="Прошлая неделя (только сегодня, четверг)">
                {editablePreviousWeekDays.map(d => (
                  <option key={d} value={d}>{dayOptionLabel(d, true)}</option>
                ))}
              </optgroup>
            )}
          </select>
          <button className="btn btn-primary" onClick={() => runImport()} disabled={loading}>
            {loading ? 'Импортируем...' : '📥 Импортировать за этот день'}
          </button>
        </div>

        {error && <div className="alert alert-danger">🔴 Ошибка импорта: {error}</div>}

        {result && (
          <div>
            <div className="alert alert-info">✅ Импорт завершён за {formatDate(result.date)}. Неделя: {formatDate(result.week_start)}</div>
            {result.processed?.length > 0 && (
              <table>
                <thead>
                  <tr>
                    <th>Источник</th>
                    <th style={{ textAlign: 'right' }}>Лиды</th>
                    <th style={{ textAlign: 'right' }}>Квалы</th>
                    <th style={{ textAlign: 'right' }}>Встречи</th>
                    <th style={{ textAlign: 'right' }}>Сделки</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {result.processed.map((r, i) => (
                    <tr key={i}>
                      <td className="td-mono">{r.source}</td>
                      <td style={{ textAlign: 'right' }}>{r.leads}</td>
                      <td style={{ textAlign: 'right' }}>{r.quals}</td>
                      <td style={{ textAlign: 'right' }}>{r.meetings}</td>
                      <td style={{ textAlign: 'right' }}>{r.deals}</td>
                      <td>{r.matched ? <span className="badge badge-active">привязан</span> : <span className="badge badge-off">не найден</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {(!result.processed || result.processed.length === 0) && (
              <div style={{ fontSize: 13, color: 'var(--text-muted)' }}>За этот день данных с источниками ofbfl- не найдено.</div>
            )}

            {result.sheet_expenses_sync?.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Расход из Google Таблиц</div>
                <table>
                  <thead>
                    <tr>
                      <th>Источник</th>
                      <th>Статус</th>
                      <th>Детали</th>
                    </tr>
                  </thead>
                  <tbody>
                    {result.sheet_expenses_sync.map((r, i) => (
                      <tr key={i}>
                        <td>{sourceLabels[r.source_id] || r.source_id || '—'}</td>
                        <td>{r.ok ? <span className="badge badge-active">ок</span> : <span className="badge badge-off">ошибка</span>}</td>
                        <td className="td-muted" style={{ fontSize: 12 }}>{r.ok ? `обновлено недель: ${r.weeks_updated}` : r.error}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="info-card" style={{ maxWidth: 760, marginBottom: 16 }}>
        <div className="info-card-title">Сделки отдела продаж</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
          Питает кабинет руководителя отдела продаж: воронка «Продажа БФЛ» с
          1 сентября — сделки, их товарные позиции и история этапов. Загрузка
          идёт несколькими проходами по минуте: сделок шесть сотен, и на
          каждую приходится три запроса в Битрикс. Кнопку нажимают один раз,
          дальше она ходит сама, пока не загрузит всё.
        </div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={runRopImport} disabled={ropLoading}>
            {ropLoading ? 'Загружаем...' : '🎯 Загрузить сделки отдела'}
          </button>
          {ropLoading && ropResult && (
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              проход {ropResult.pass} · {ROP_PHASES[ropResult.phase] || ropResult.phase}
            </span>
          )}
        </div>

        {ropError && <div className="alert alert-danger" style={{ marginTop: 12 }}>🔴 Ошибка загрузки: {ropError}</div>}

        {ropResult && !ropError && (
          <div className="alert alert-info" style={{ marginTop: 12 }}>
            {ropResult.done
              ? `✅ Загрузка завершена за ${ropResult.pass} ${ropResult.pass === 1 ? 'проход' : ropResult.pass < 5 ? 'прохода' : 'проходов'}.`
              : `Идёт ${ROP_PHASES[ropResult.phase] || ropResult.phase}: `}
            {' '}сделок {ropResult.totals?.deals ?? 0}, позиций {ropResult.totals?.products ?? 0},
            {' '}записей истории {ropResult.totals?.stages ?? 0}.
          </div>
        )}
      </div>

      <div className="info-card" style={{ maxWidth: 760 }}>
        <div className="info-card-title">Нераспознанные источники</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Источники из Битрикса с префиксом ofbfl-, которые ещё не привязаны ни к одному подрядчику. Привязка задним числом восстановит данные за все дни, где встречался этот источник.
        </div>
        {unmatchedList.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)', fontSize: 13 }}>✅ Нет нераспознанных источников</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {unmatchedList.map(u => (
              <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
                <code style={{ fontSize: 12, flex: 1 }}>{u.source_marker}</code>
                <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>{u.total_leads} лидов</span>
                <select className="form-select" style={{ maxWidth: 220 }} defaultValue="" onChange={e => linkSource(u.id, u.source_marker, e.target.value)}>
                  <option value="" disabled>Привязать к подрядчику...</option>
                  {contractors.map(c => <option key={c.id} value={c.id}>{c.short_name || c.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
