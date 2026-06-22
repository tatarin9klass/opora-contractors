import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { weekStart } from '../lib/helpers.js'

export default function WeeklyFactModal({ contractorId, contractorName, onClose, onSaved }) {
  const [sources, setSources] = useState([])
  const [form, setForm] = useState({
    week_start: weekStart(),
    source_id: '',
    leads: '',
    spend: '',
    quals: '',
    meetings: '',
    deals: '',
    comment: '',
    entered_by: '',
    verify_status: 'введён',
  })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (contractorId) {
      supabase.from('sources').select('*').eq('contractor_id', contractorId).eq('status', 'активен')
        .then(({ data }) => setSources(data || []))
    }
  }, [contractorId])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const cpl = form.leads && form.spend ? Math.round(Number(form.spend) / Number(form.leads)) : null
  const cpql = form.quals && form.spend ? Math.round(Number(form.spend) / Number(form.quals)) : null

  async function handleSave() {
    if (!form.week_start || !form.entered_by) {
      alert('Укажите неделю и кто вносит данные')
      return
    }
    setLoading(true)
    const { error } = await supabase.from('weekly_facts').insert({
      contractor_id: contractorId,
      source_id: form.source_id || null,
      week_start: form.week_start,
      leads: Number(form.leads) || 0,
      spend: Number(form.spend) || 0,
      quals: Number(form.quals) || 0,
      meetings: Number(form.meetings) || 0,
      deals: Number(form.deals) || 0,
      comment: form.comment,
      entered_by: form.entered_by,
      verify_status: form.verify_status,
    })
    setLoading(false)
    if (error) { alert('Ошибка: ' + error.message); return }
    onSaved()
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2>Недельный факт{contractorName ? ` — ${contractorName}` : ''}</h2>
          <button className="btn-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Неделя (начало) <span className="req">*</span></label>
              <input className="form-input" type="date" value={form.week_start} onChange={e => set('week_start', e.target.value)} />
            </div>
            <div className="form-group">
              <label className="form-label">Источник</label>
              <select className="form-select" value={form.source_id} onChange={e => set('source_id', e.target.value)}>
                <option value="">Все источники</option>
                {sources.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Лиды</label>
              <input className="form-input" type="number" value={form.leads} onChange={e => set('leads', e.target.value)} placeholder="0" />
            </div>
            <div className="form-group">
              <label className="form-label">Расход (₽)</label>
              <input className="form-input" type="number" value={form.spend} onChange={e => set('spend', e.target.value)} placeholder="0" />
            </div>
          </div>

          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Квалы</label>
              <input className="form-input" type="number" value={form.quals} onChange={e => set('quals', e.target.value)} placeholder="0" />
            </div>
            <div className="form-group">
              <label className="form-label">Встречи</label>
              <input className="form-input" type="number" value={form.meetings} onChange={e => set('meetings', e.target.value)} placeholder="0" />
            </div>
          </div>

          <div className="form-group">
            <label className="form-label">Сделки (первые оплаты)</label>
            <input className="form-input" type="number" value={form.deals} onChange={e => set('deals', e.target.value)} placeholder="0" />
          </div>

          {(cpl || cpql) && (
            <div style={{ background: 'var(--green-bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: '10px 14px', marginBottom: 14, display: 'flex', gap: 24 }}>
              {cpl && <div><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>CPL</span><div style={{ fontSize: 16, fontWeight: 700 }}>{cpl.toLocaleString('ru-RU')} ₽</div></div>}
              {cpql && <div><span style={{ fontSize: 11, color: 'var(--text-muted)' }}>CPQL</span><div style={{ fontSize: 16, fontWeight: 700 }}>{cpql.toLocaleString('ru-RU')} ₽</div></div>}
            </div>
          )}

          <div className="form-group">
            <label className="form-label">Комментарий</label>
            <textarea className="form-textarea" value={form.comment} onChange={e => set('comment', e.target.value)} placeholder="Причины отклонений, особенности недели..." rows={2} />
          </div>
          <div className="form-group">
            <label className="form-label">Кто вносит данные <span className="req">*</span></label>
            <input className="form-input" value={form.entered_by} onChange={e => set('entered_by', e.target.value)} placeholder="Имя" />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={loading}>
            {loading ? 'Сохранение...' : '✓ Сохранить'}
          </button>
        </div>
      </div>
    </div>
  )
}
