import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'

export default function AddDecisionModal({ contractorId, onClose, onSaved }) {
  const [types, setTypes] = useState([])
  const [form, setForm] = useState({
    decision_type_id: '',
    comment: '',
    author: '',
    next_step: '',
    decision_date: new Date().toISOString().split('T')[0],
  })
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    supabase.from('decision_types').select('*').order('name').then(({ data }) => setTypes(data || []))
  }, [])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function handleSave() {
    if (!form.comment || !form.author) {
      alert('Заполните комментарий и автора')
      return
    }
    setLoading(true)
    const { error } = await supabase.from('management_decisions').insert({
      contractor_id: contractorId,
      decision_type_id: form.decision_type_id ? Number(form.decision_type_id) : null,
      comment: form.comment,
      author: form.author,
      next_step: form.next_step,
      decision_date: form.decision_date,
    })
    setLoading(false)
    if (error) { alert('Ошибка: ' + error.message); return }
    onSaved()
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2>Управленческое решение</h2>
          <button className="btn-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Тип решения</label>
              <select className="form-select" value={form.decision_type_id} onChange={e => set('decision_type_id', e.target.value)}>
                <option value="">— выберите —</option>
                {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            </div>
            <div className="form-group">
              <label className="form-label">Дата</label>
              <input className="form-input" type="date" value={form.decision_date} onChange={e => set('decision_date', e.target.value)} />
            </div>
          </div>
          <div className="form-group">
            <label className="form-label">Комментарий <span className="req">*</span></label>
            <textarea className="form-textarea" value={form.comment} onChange={e => set('comment', e.target.value)} placeholder="Что решили и почему..." rows={4} />
          </div>
          <div className="form-group">
            <label className="form-label">Следующий шаг</label>
            <input className="form-input" value={form.next_step} onChange={e => set('next_step', e.target.value)} placeholder="Что делаем дальше..." />
          </div>
          <div className="form-group">
            <label className="form-label">Автор <span className="req">*</span></label>
            <input className="form-input" value={form.author} onChange={e => set('author', e.target.value)} placeholder="Имя" />
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={loading}>
            {loading ? 'Сохранение...' : '✓ Зафиксировать'}
          </button>
        </div>
      </div>
    </div>
  )
}
