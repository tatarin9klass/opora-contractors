import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'

export default function SetTargetModal({ month, existing, onClose, onSaved }) {
  const [form, setForm] = useState({
    plan_spend: existing?.plan_spend || '',
    plan_leads: existing?.plan_leads || '',
    plan_quals: existing?.plan_quals || '',
    plan_meetings: existing?.plan_meetings || '',
    plan_deals: existing?.plan_deals || '',
  })
  const [loading, setLoading] = useState(false)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const monthLabel = new Date(month).toLocaleString('ru-RU', { month: 'long', year: 'numeric' })

  async function handleSave() {
    setLoading(true)
    const payload = {
      month,
      plan_spend: form.plan_spend ? Number(form.plan_spend) : null,
      plan_leads: form.plan_leads ? Number(form.plan_leads) : null,
      plan_quals: form.plan_quals ? Number(form.plan_quals) : null,
      plan_meetings: form.plan_meetings ? Number(form.plan_meetings) : null,
      plan_deals: form.plan_deals ? Number(form.plan_deals) : null,
    }

    if (existing) {
      await supabase.from('monthly_targets').update(payload).eq('id', existing.id)
    } else {
      await supabase.from('monthly_targets').insert(payload)
    }
    setLoading(false)
    onSaved()
  }

  // Только 5 базовых метрик (ТЗ раздел 5.1) — плановые значения CPL/CPQL/CAC/CR
  // на карточках дашборда считаются автоматически из этих пяти, отдельно их
  // вводить не нужно.
  const fields = [
    { key: 'plan_spend', label: 'Расход (₽)', placeholder: '140000' },
    { key: 'plan_leads', label: 'Лиды', placeholder: '112' },
    { key: 'plan_quals', label: 'Квалы (QL)', placeholder: '24' },
    { key: 'plan_meetings', label: 'Встречи', placeholder: '13' },
    { key: 'plan_deals', label: 'Сделки', placeholder: '2' },
  ]

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <h2>{existing ? 'Редактировать план' : 'Задать план'} — {monthLabel}</h2>
          <button className="btn-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          {fields.map((f, i) => f.section ? (
            <div key={i} className="form-section-title" style={{ marginTop: i > 0 ? 8 : 0 }}>{f.section}</div>
          ) : (
            <div key={f.key} className="form-group" style={{ marginBottom: 10 }}>
              <label className="form-label">{f.label}</label>
              <input
                className="form-input"
                type="number"
                value={form[f.key]}
                onChange={e => set(f.key, e.target.value)}
                placeholder={f.placeholder}
              />
            </div>
          ))}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={loading}>
            {loading ? 'Сохранение...' : '✓ Сохранить план'}
          </button>
        </div>
      </div>
    </div>
  )
}
