import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'

export default function AddContractorModal({ onClose, onSaved }) {
  const [types, setTypes] = useState([])
  const [statuses, setStatuses] = useState([])
  const [paymentTypes, setPaymentTypes] = useState([])
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({
    name: '', short_name: '', type_id: '', status_id: '',
    responsible_name: '', contact_name: '', contact_telegram: '',
    contact_phone: '', comment: '',
    payment_type_id: '', cpl_rate: '', retainer: '', ad_budget: '',
    has_prepayment: false,
  })

  useEffect(() => {
    Promise.all([
      supabase.from('contractor_types').select('*').order('name'),
      supabase.from('contractor_statuses').select('*').order('sort_order'),
      supabase.from('payment_types').select('*').order('name'),
    ]).then(([t, s, p]) => {
      setTypes(t.data || [])
      // default status = "Новый / подготовка"
      const def = (s.data || []).find(x => x.name === 'Новый / подготовка')
      setStatuses(s.data || [])
      setForm(f => ({ ...f, status_id: def?.id || '' }))
      setPaymentTypes(p.data || [])
    })
  }, [])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function handleSave() {
    if (!form.name || !form.short_name || !form.type_id || !form.status_id || !form.responsible_name) {
      alert('Заполните обязательные поля')
      return
    }
    setLoading(true)
    const { data: contractor, error } = await supabase.from('contractors').insert({
      name: form.name, short_name: form.short_name,
      type_id: Number(form.type_id), status_id: Number(form.status_id),
      responsible_name: form.responsible_name,
      contact_name: form.contact_name, contact_telegram: form.contact_telegram,
      contact_phone: form.contact_phone, comment: form.comment,
    }).select().single()

    if (error) { alert('Ошибка: ' + error.message); setLoading(false); return }

    // Save payment model if type selected
    if (form.payment_type_id) {
      await supabase.from('payment_models').insert({
        contractor_id: contractor.id,
        payment_type_id: Number(form.payment_type_id),
        cpl_rate: form.cpl_rate ? Number(form.cpl_rate) : null,
        retainer: form.retainer ? Number(form.retainer) : null,
        ad_budget: form.ad_budget ? Number(form.ad_budget) : null,
        has_prepayment: form.has_prepayment,
      })
    }

    setLoading(false)
    onSaved(contractor)
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal modal-lg">
        <div className="modal-header">
          <h2>Новый подрядчик</h2>
          <button className="btn-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div className="form-section">
            <div className="form-section-title">Основное</div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Название <span className="req">*</span></label>
                <input className="form-input" value={form.name} onChange={e => set('name', e.target.value)} placeholder="Полное название" />
              </div>
              <div className="form-group">
                <label className="form-label">Краткое название <span className="req">*</span></label>
                <input className="form-input" value={form.short_name} onChange={e => set('short_name', e.target.value)} placeholder="Для таблиц" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Тип <span className="req">*</span></label>
                <select className="form-select" value={form.type_id} onChange={e => set('type_id', e.target.value)}>
                  <option value="">— выберите —</option>
                  {types.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Статус <span className="req">*</span></label>
                <select className="form-select" value={form.status_id} onChange={e => set('status_id', e.target.value)}>
                  <option value="">— выберите —</option>
                  {statuses.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                </select>
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Ответственный внутри компании <span className="req">*</span></label>
              <input className="form-input" value={form.responsible_name} onChange={e => set('responsible_name', e.target.value)} placeholder="Имя сотрудника" />
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">Контакты</div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Контакт подрядчика</label>
                <input className="form-input" value={form.contact_name} onChange={e => set('contact_name', e.target.value)} placeholder="ФИО / ник" />
              </div>
              <div className="form-group">
                <label className="form-label">Telegram</label>
                <input className="form-input" value={form.contact_telegram} onChange={e => set('contact_telegram', e.target.value)} placeholder="@username" />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Телефон</label>
              <input className="form-input" value={form.contact_phone} onChange={e => set('contact_phone', e.target.value)} placeholder="+7..." />
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">Модель оплаты (можно заполнить позже)</div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Тип оплаты</label>
                <select className="form-select" value={form.payment_type_id} onChange={e => set('payment_type_id', e.target.value)}>
                  <option value="">— выберите —</option>
                  {paymentTypes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Ставка CPL (₽)</label>
                <input className="form-input" type="number" value={form.cpl_rate} onChange={e => set('cpl_rate', e.target.value)} placeholder="0" />
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Абонентка (₽)</label>
                <input className="form-input" type="number" value={form.retainer} onChange={e => set('retainer', e.target.value)} placeholder="0" />
              </div>
              <div className="form-group">
                <label className="form-label">Рекламный бюджет (₽)</label>
                <input className="form-input" type="number" value={form.ad_budget} onChange={e => set('ad_budget', e.target.value)} placeholder="0" />
              </div>
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">Комментарий</div>
            <div className="form-group">
              <textarea className="form-textarea" value={form.comment} onChange={e => set('comment', e.target.value)} placeholder="Краткая информация о подрядчике..." rows={3} />
            </div>
          </div>
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Отмена</button>
          <button className="btn btn-primary" onClick={handleSave} disabled={loading}>
            {loading ? 'Сохранение...' : '✓ Создать подрядчика'}
          </button>
        </div>
      </div>
    </div>
  )
}
