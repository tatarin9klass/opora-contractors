import React, { useState } from 'react'
import { supabase } from '../lib/supabase.js'

const FUNCTION_URL = 'https://jgmuuehxavwlrfkonnzx.supabase.co/functions/v1/bitrix-import'
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpnbXV1ZWh4YXZ3bHJma29ubnp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNzY4MzAsImV4cCI6MjA5NzY1MjgzMH0.BvX2ZBVSs17Vuwq_ok_e_QyAck0FG2yYTtuOkbaUrqU'

export default function ImportPage() {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  async function runImport() {
    setLoading(true)
    setError(null)
    setResult(null)
    try {
      const res = await fetch(FUNCTION_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ANON_KEY}`,
          'apikey': ANON_KEY,
        },
        body: JSON.stringify({}),
      })
      const json = await res.json()
      if (!json.success) {
        setError(json.error || 'Неизвестная ошибка')
      } else {
        setResult(json)
      }
    } catch (e) {
      setError(String(e))
    }
    setLoading(false)
  }

  return (
    <div>
      <div className="info-card" style={{ maxWidth: 700 }}>
        <div className="info-card-title">Импорт данных из Битрикс24</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
          Подтягивает лиды, квалы, встречи и сделки за прошедшую отчётную неделю (чт–ср) и
          распределяет их по подрядчикам через roistat-маркер источника. Расход не затрагивается —
          вводится вручную в паспорте подрядчика.
        </div>

        <button className="btn btn-primary" onClick={runImport} disabled={loading}>
          {loading ? 'Импортируем...' : '📥 Запустить импорт сейчас'}
        </button>

        {error && (
          <div className="alert alert-danger" style={{ marginTop: 16 }}>
            🔴 Ошибка импорта: {error}
          </div>
        )}

        {result && (
          <div style={{ marginTop: 20 }}>
            <div className="alert alert-info">
              ✅ Импорт завершён. Неделя: {result.week_start} — {result.week_end}
            </div>

            {result.processed?.length > 0 && (
              <div style={{ marginTop: 12 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 8 }}>
                  Обработано источников: {result.processed.length}
                </div>
                <table>
                  <thead>
                    <tr>
                      <th>Источник</th>
                      <th style={{ textAlign: 'right' }}>Лиды</th>
                      <th style={{ textAlign: 'right' }}>Квалы</th>
                      <th style={{ textAlign: 'right' }}>Встречи</th>
                      <th style={{ textAlign: 'right' }}>Сделки</th>
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
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {result.unmatched_sources?.length > 0 && (
              <div className="alert alert-warning" style={{ marginTop: 12 }}>
                ⚠️ Источники не найдены в системе (не привязаны к подрядчику): {result.unmatched_sources.join(', ')}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
