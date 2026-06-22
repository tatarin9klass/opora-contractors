import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'

export default function ChangeStatusModal({ contractor, onClose, onSaved }) {
  const [statuses, setStatuses] = useState([])
  const [reasons, setReasons] = useState([])
  const [form, setForm] = useState({
    new_status_id: '',
    reason_id: '',
    comment: '',
    changed_by: '',
  })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    Promise.all([
      supabase.from('contractor_statuses').select('*').order('sort_order'),
      supabase.from('status_change_reasons').select('*').order('name'),
    ]).then(([s, r]) => {
      setStatuses(s.data || [])
      setReasons(r.data || [])
      setForm(f => ({ ...f, new_status_id: String(contractor.status_id || '') }))
    })
  }, [])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function handleSave() {
    if (!form.new_status_id || !form.changed_by) {
      alert('Укажите новый статус и автора изменения')
      return
    }
    setLoading(true)

    // Save to status_history
    await supabase.from('status_history').insert({
      contractor_id: contractor.id,
      old_status_id: contractor.status_id,
      new_status_id: Number(form.new_status_id),
      reason_id: form.reason_id ? Number(form.reason_id) : null,
      comment: form.comment,
      changed_by: form.changed_by,
    })

    // Update contractor
    await supabase.from('contractors').update({
      status_id: Number(form.new_status_id),
    }).eq('id', contractor.id)

    setLoading(false)
    onSaved()
  }

  const currentStatus = statuses.find(s => s.id === contractor.status_id)
  const newStatus = statuses.find(s => s.id === Number(form.new_status_id))

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2>Изменить статус</h2>
          <button className="btn-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="form-group">
            <label className="form-label">Текущий статус</label>
            <div style={{ fontSize: 13, color: 'var(--text-secondary)', padding: '6px 0' }}>
              {currentStatus?.name || '—'}
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Новый статус <span className="req">*</span></label>
            <select className="form-select" value={form.new_status_id} onChange={e => set('new_status_id', e.target.value)}>
              <option value="">— выберите —</option>
              {statuses.map(s => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Причина изменения</label>
            <select className="form-select" value={form.reason_id} onChange={e => set('reason_id', e.target.value)}>
              <option value="">— выберите —</option>
              {reasons.map(r => (
                <option key={r.id} value={r.id}>{r.name}</option>
              ))}
            </select>
          </div>
          <div className="form-group">
            <label className="form-label">Комментарий</label>
            <textarea className="form-textarea" value={form.comment} onChange={e => set('comment', e.target.value)} placeholder="Подробности решения..." rows={3} />
          </div>
          <div className="form-group">
            <label className="form-label">Кто принял решение <span className="req">*</span></label>
            <input className="form-input" value={form.changed_by} onChange={e => set('changed_by', e.target.value)} placeholder="Имя" />
          </div>
          {newStatus && !newStatus.is_active && (
            <div className="alert alert-warning">
              ⚠️ Подрядчик будет переведён в неактивный список
            </div>
          )}
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
