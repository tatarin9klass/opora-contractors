import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatDate } from '../lib/helpers.js'

const FUNCTION_URL = 'https://jgmuuehxavwlrfkonnzx.supabase.co/functions/v1/bitrix-import'
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpnbXV1ZWh4YXZ3bHJma29ubnp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNzY4MzAsImV4cCI6MjA5NzY1MjgzMH0.BvX2ZBVSs17Vuwq_ok_e_QyAck0FG2yYTtuOkbaUrqU'

// Отчётная неделя Опоры: чт-ср
function getWeekStartOf(date) {
  const d = new Date(date)
  const day = d.getDay()
  const diff = day >= 4 ? day - 4 : day + 3
  d.setDate(d.getDate() - diff)
  d.setHours(0, 0, 0, 0)
  return d
}

function toISODate(d) {
  return d.toISOString().split('T')[0]
}

function weekDaysFrom(thursday, upToDate = null) {
  const days = []
  for (let i = 0; i < 7; i++) {
    const d = new Date(thursday)
    d.setDate(thursday.getDate() + i)
    if (upToDate && d > upToDate) break
    days.push(toISODate(d))
  }
  return days
}

// Список доступных дат для импорта:
// - все прошедшие дни текущей отчётной недели (чт..сегодня)
// - ЕСЛИ сегодня четверг (день начала новой недели) — дополнительно вся ТОЛЬКО ЧТО закрывшаяся
//   предыдущая неделя целиком (чт..ср), чтобы можно было перепроверить и перезалить перед тем как
//   она "закроется" окончательно для правок.
function getSelectableDays() {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const currentWeekThu = getWeekStartOf(today)
  const isThursday = today.getDay() === 4 && toISODate(today) === toISODate(currentWeekThu)

  const currentWeekDays = weekDaysFrom(currentWeekThu, today)

  if (!isThursday) {
    return currentWeekDays
  }

  const prevWeekThu = new Date(currentWeekThu)
  prevWeekThu.setDate(currentWeekThu.getDate() - 7)
  const prevWeekDays = weekDaysFrom(prevWeekThu) // все 7 дней прошлой недели

  return [...currentWeekDays, ...prevWeekDays]
}

const DAY_NAMES = ['вс', 'пн', 'вт', 'ср', 'чт', 'пт', 'сб']

export default function ImportPage() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [selectedDate, setSelectedDate] = useState(() => new Date().toISOString().split('T')[0])
  const [unmatchedList, setUnmatchedList] = useState([])
  const [contractors, setContractors] = useState([])

  const selectableDays = getSelectableDays()
  const today = new Date().toISOString().split('T')[0]
  const currentWeekThu = toISODate(getWeekStartOf(new Date()))
  const isThursday = today === currentWeekThu

  async function loadUnmatched() {
    const { data } = await supabase.from('unmatched_sources').select('*').is('linked_contractor_id', null).order('total_leads', { ascending: false })
    setUnmatchedList(data || [])
  }

  useEffect(() => {
    loadUnmatched()
    supabase.from('contractors').select('id, name, short_name').order('name').then(({ data }) => setContractors(data || []))
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

  async function linkSource(unmatchedId, sourceMarker, contractorId) {
    if (!contractorId) return
    const { data: newSource } = await supabase.from('sources').insert({
      contractor_id: contractorId, name: sourceMarker, roistat_marker: sourceMarker, status: 'активен',
    }).select().single()
    await supabase.from('daily_facts').update({ contractor_id: contractorId, source_id: newSource.id }).eq('source_marker', sourceMarker)
    await supabase.from('unmatched_sources').update({ linked_contractor_id: contractorId }).eq('id', unmatchedId)
    loadUnmatched()
  }

  return (
    <div>
      <div className="info-card" style={{ maxWidth: 760, marginBottom: 16 }}>
        <div className="info-card-title">Импорт данных из Битрикс24</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
          Подтягивает лиды, квалы, встречи и сделки за выбранный день и распределяет их по подрядчикам через
          roistat-маркер источника. Расход вводится отдельно вручную.
        </div>

        {isThursday && (
          <div className="alert alert-info">
            📅 Сегодня четверг — доступна вся только что закрывшаяся предыдущая неделя для перепроверки, помимо текущей.
          </div>
        )}

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
          <select className="form-select" value={selectedDate} onChange={e => setSelectedDate(e.target.value)}>
            {selectableDays.map(d => {
              const dateObj = new Date(d + 'T00:00:00')
              const isToday = d === today
              const isPrevWeek = d < currentWeekThu
              return (
                <option key={d} value={d}>
                  {DAY_NAMES[dateObj.getDay()]} {formatDate(d)} {isToday ? '(сегодня)' : ''} {isPrevWeek ? '· прошлая неделя' : ''}
                </option>
              )
            })}
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
