import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'

export default function AddContractorModal({ onClose, onSaved }) {
  const [types, setTypes] = useState([])
  const [statuses, setStatuses] = useState([])
  const [paymentTypes, setPaymentTypes] = useState([])
  const [loading, setLoading] = useState(false)
  const [form, setForm] = useState({
    short_name: '',
    type_id: '',
    status_id: '',
    responsible_name: '',
    comment: '',
    spend_by_source: false,
    // Первый источник
    source_name: '',
    source_phone: '',
    source_landing: '',
    // Оплата источника
    payment_type_id: '',
    cpl_rate: '',
    retainer: '',
    ad_budget: '',
  })

  useEffect(() => {
    Promise.all([
      supabase.from('contractor_types').select('*').order('name'),
      supabase.from('contractor_statuses').select('*').order('sort_order'),
      supabase.from('payment_types').select('*').order('name'),
    ]).then(([t, s, p]) => {
      setTypes(t.data || [])
      setStatuses(s.data || [])
      setPaymentTypes(p.data || [])
      // Дефолт статус = "Новый"
      const def = (s.data || []).find(x => x.name === 'Новый')
      if (def) setForm(f => ({ ...f, status_id: String(def.id) }))
    })
  }, [])

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  async function handleSave() {
    if (!form.short_name || !form.type_id || !form.status_id || !form.responsible_name) {
      alert('Заполните обязательные поля: название, тип, статус, ответственный')
      return
    }
    if (!form.source_name) {
      alert('Добавьте хотя бы один источник (roistat marker)')
      return
    }
    setLoading(true)

    // Создаём подрядчика
    const { data: contractor, error } = await supabase.from('contractors').insert({
      name: form.short_name, // name = short_name для простоты
      short_name: form.short_name,
      type_id: Number(form.type_id),
      status_id: Number(form.status_id),
      responsible_name: form.responsible_name,
      comment: form.comment,
      spend_by_source: form.spend_by_source,
    }).select().single()

    if (error) { alert('Ошибка: ' + error.message); setLoading(false); return }

    // Создаём первый источник
    await supabase.from('sources').insert({
      contractor_id: contractor.id,
      name: form.source_name, // название = маркер
      roistat_marker: form.source_name,
      calltracking_phone: form.source_phone || null,
      landing_url: form.source_landing || null,
      payment_type_id: form.payment_type_id ? Number(form.payment_type_id) : null,
      cpl_rate: form.cpl_rate ? Number(form.cpl_rate) : null,
      retainer: form.retainer ? Number(form.retainer) : null,
      ad_budget: form.ad_budget ? Number(form.ad_budget) : null,
      status: 'активен',
    })

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
                <label className="form-label">Название подрядчика <span className="req">*</span></label>
                <input className="form-input" value={form.short_name} onChange={e => set('short_name', e.target.value)} placeholder="Например: Ригиль" />
              </div>
              <div className="form-group">
                <label className="form-label">Ответственный <span className="req">*</span></label>
                <input className="form-input" value={form.responsible_name} onChange={e => set('responsible_name', e.target.value)} placeholder="Кто ведёт подрядчика" />
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
              <label className="form-label">Комментарий</label>
              <textarea className="form-textarea" value={form.comment} onChange={e => set('comment', e.target.value)} placeholder="Краткое описание подрядчика..." rows={2} />
            </div>
            <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                id="spend_by_source"
                checked={form.spend_by_source}
                onChange={e => set('spend_by_source', e.target.checked)}
              />
              <label htmlFor="spend_by_source" style={{ fontSize: 13, cursor: 'pointer' }}>
                Вводить расход суммарно по подрядчику (не по источникам)
              </label>
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">Первый источник <span className="req">*</span></div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Roistat marker <span className="req">*</span></label>
                <input
                  className="form-input"
                  value={form.source_name}
                  onChange={e => set('source_name', e.target.value)}
                  placeholder="ofbfl-название"
                />
                <div className="form-hint">Это же значение будет именем источника</div>
              </div>
              <div className="form-group">
                <label className="form-label">Телефон КТ</label>
                <input className="form-input" value={form.source_phone} onChange={e => set('source_phone', e.target.value)} placeholder="+7..." />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Посадочная страница</label>
              <input className="form-input" value={form.source_landing} onChange={e => set('source_landing', e.target.value)} placeholder="https://..." />
            </div>
          </div>

          <div className="form-section">
            <div className="form-section-title">Модель оплаты источника</div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Тип оплаты</label>
                <select className="form-select" value={form.payment_type_id} onChange={e => set('payment_type_id', e.target.value)}>
                  <option value="">— выберите —</option>
                  {paymentTypes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Ставка за лид (₽)</label>
                <input className="form-input" type="number" value={form.cpl_rate} onChange={e => set('cpl_rate', e.target.value)} placeholder="0" />
                <div className="form-hint">Для модели CPL / фикс за лид</div>
              </div>
            </div>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Абонентка (₽/мес)</label>
                <input className="form-input" type="number" value={form.retainer} onChange={e => set('retainer', e.target.value)} placeholder="0" />
              </div>
              <div className="form-group">
                <label className="form-label">Плановый бюджет (₽/мес)</label>
                <input className="form-input" type="number" value={form.ad_budget} onChange={e => set('ad_budget', e.target.value)} placeholder="0" />
              </div>
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
