import React, { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase.js'

const FUNCTION_URL = 'https://jgmuuehxavwlrfkonnzx.supabase.co/functions/v1/avtp-import'
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpnbXV1ZWh4YXZ3bHJma29ubnp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNzY4MzAsImV4cCI6MjA5NzY1MjgzMH0.BvX2ZBVSs17Vuwq_ok_e_QyAck0FG2yYTtuOkbaUrqU'

// Импорт за 9 месяцев не укладывается в один вызов Edge Function, поэтому
// функция возвращает done=false и позицию, а фронт просто дёргает её по кругу,
// пока не придёт done=true. Предохранитель от бесконечного цикла, если
// функция вдруг перестанет двигаться вперёд.
const MAX_PASSES = 40

const PHASE_LABEL = {
  leads: 'лиды',
  deals: 'сделки',
  idle: 'завершено',
}

export default function AvtpImportPage() {
  const [running, setRunning] = useState(false)
  const [progress, setProgress] = useState(null)
  const [error, setError] = useState(null)
  const [channels, setChannels] = useState([])
  const [unmapped, setUnmapped] = useState([])
  const cancelRef = useRef(false)

  async function loadRefs() {
    const [{ data: ch }, { data: um }] = await Promise.all([
      supabase.from('ap_channels').select('id, name, direction').order('sort_order'),
      supabase.from('ap_sources').select('id, bitrix_name, direction').is('channel_id', null).order('bitrix_name'),
    ])
    setChannels(ch || [])
    setUnmapped(um || [])
  }

  useEffect(() => { loadRefs() }, [])

  async function callImport(payload) {
    const res = await fetch(FUNCTION_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${ANON_KEY}`, 'apikey': ANON_KEY },
      body: JSON.stringify(payload),
    })
    return res.json()
  }

  async function runSync(reset) {
    setRunning(true)
    setError(null)
    cancelRef.current = false
    let leads = 0
    let deals = 0
    try {
      for (let pass = 0; pass < MAX_PASSES; pass++) {
        if (cancelRef.current) break
        const json = await callImport(pass === 0 && reset ? { reset: true } : {})
        if (!json.success) { setError(json.error || 'Неизвестная ошибка'); break }
        leads += json.leads_upserted || 0
        deals += json.deals_upserted || 0
        setProgress({ ...json, total_leads: leads, total_deals: deals, pass: pass + 1 })
        if (json.done) break
      }
      await loadRefs()
    } catch (e) {
      setError(String(e))
    }
    setRunning(false)
  }

  async function assignChannel(sourceId, channelId) {
    if (!channelId) return
    await supabase.from('ap_sources').update({ channel_id: channelId }).eq('id', sourceId)
    loadRefs()
  }

  return (
    <div>
      <div className="info-card" style={{ maxWidth: 760, marginBottom: 16 }}>
        <div className="info-card-title">Импорт направления АВТОПРАВО</div>
        <div style={{ fontSize: 13, color: 'var(--text-secondary)', marginBottom: 16 }}>
          Тянет из Битрикса все лиды с источниками avtpr/avrkm (по дате создания, стадия лида не важна)
          и все сделки воронок «Автоправо. Продажи» и «Аварийные комиссары» с их текущими стадиями.
          Лиды догружаются инкрементально, сделки пересканируются целиком — их текущая стадия и решает,
          считать сделку договором или нет.
        </div>

        <div style={{ display: 'flex', gap: 10, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
          <button className="btn btn-primary" onClick={() => runSync(false)} disabled={running}>
            {running ? 'Синхронизируем...' : '🔄 Синхронизировать'}
          </button>
          <button className="btn btn-secondary btn-sm" onClick={() => runSync(true)} disabled={running}>
            Полная перезаливка с нуля
          </button>
          {running && (
            <button className="btn btn-ghost btn-sm" onClick={() => { cancelRef.current = true }}>
              Остановить
            </button>
          )}
        </div>

        {error && <div className="alert alert-danger">🔴 Ошибка импорта: {error}</div>}

        {progress && (
          <div>
            <div className={`alert ${progress.done ? 'alert-info' : 'alert-warning'}`}>
              {progress.done
                ? `✅ Синхронизация завершена. Лидов записано: ${progress.total_leads}, сделок: ${progress.total_deals}.`
                : `⏳ Идёт ${PHASE_LABEL[progress.phase] || progress.phase}… проход ${progress.pass}, лидов ${progress.total_leads}, сделок ${progress.total_deals}.`}
            </div>
            {progress.new_sources?.length > 0 && (
              <div style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                Новые источники в Битриксе: {progress.new_sources.join(', ')}
              </div>
            )}
          </div>
        )}
      </div>

      <div className="info-card" style={{ maxWidth: 760 }}>
        <div className="info-card-title">Источники без канала</div>
        <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
          Источники avtpr, которых нет в разбивке по группам каналов. Их лиды и договоры считаются,
          но лежат в строке «Без канала», пока источник не привязан.
        </div>
        {unmapped.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text-muted)', fontSize: 13 }}>✅ Все источники привязаны</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {unmapped.map(u => (
              <div key={u.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '10px 12px', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)' }}>
                <code style={{ fontSize: 12, flex: 1 }}>{u.bitrix_name}</code>
                <select className="form-select" style={{ maxWidth: 220 }} defaultValue="" onChange={e => assignChannel(u.id, e.target.value)}>
                  <option value="" disabled>Привязать к каналу...</option>
                  {channels.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                </select>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
