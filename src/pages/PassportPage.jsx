import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { getStatusClass, cplClass, cpqlClass, cacClass, formatMoney, formatDate, metricCardClass } from '../lib/helpers.js'
import ChangeStatusModal from '../components/ChangeStatusModal.jsx'
import AddDecisionModal from '../components/AddDecisionModal.jsx'
import WeeklyFactModal from '../components/WeeklyFactModal.jsx'
import DeleteContractorModal from '../components/DeleteContractorModal.jsx'

// Вкладка «Расход» удалена (ТЗ раздел 8.2) — ввод расхода переехал в отдельный
// раздел «Ввод расходов» (src/pages/WeeklyExpensesPage.jsx), не в паспорт.
const TABS = ['Обзор', 'Источники и оплата', 'Факт', 'Решения', 'Счета', 'Файлы', 'История']

const PAYMENT_TYPE_LABELS = {
  'CPL': 'CPL',
  'Фикс': 'Фикс',
  'Абонентка': 'Абонентка',
  'Абонентка + бюджет': 'Або + бюджет',
  'Процент': 'Процент',
  'Смешанная': 'Смешанная',
}

export default function PassportPage({ contractorId, onBack }) {
  const [tab, setTab] = useState('Обзор')
  const [contractor, setContractor] = useState(null)
  const [mtd, setMtd] = useState(null)
  const [sources, setSources] = useState([])
  const [paymentTypes, setPaymentTypes] = useState([])
  const [facts, setFacts] = useState([])
  const [decisions, setDecisions] = useState([])
  const [statusHistory, setStatusHistory] = useState([])
  const [invoices, setInvoices] = useState([])
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [showStatus, setShowStatus] = useState(false)
  const [showDecision, setShowDecision] = useState(false)
  const [showFact, setShowFact] = useState(false)
  const [editingSource, setEditingSource] = useState(null)
  const [showAddSource, setShowAddSource] = useState(false)
  const [newSource, setNewSource] = useState({ name: '', roistat_marker: '', calltracking_phone: '', landing_url: '', payment_type_id: '', cpl_rate: '', retainer: '', ad_budget: '' })
  const [editContractor, setEditContractor] = useState(false)
  const [showDelete, setShowDelete] = useState(false)
  const [archiveStatusId, setArchiveStatusId] = useState(null)
  const [contractorForm, setContractorForm] = useState({})
  const [target, setTarget] = useState(null)
  const [editTarget, setEditTarget] = useState(false)
  const [targetForm, setTargetForm] = useState({})
  const [targetSaving, setTargetSaving] = useState(false)
  const [uploadFileType, setUploadFileType] = useState('Договор')
  const [uploadedByName, setUploadedByName] = useState('')
  const [selectedFile, setSelectedFile] = useState(null)
  const [uploading, setUploading] = useState(false)

  async function load() {
    setLoading(true)
    const [c, m, s, f, d, sh, inv, fi, pt, tg] = await Promise.all([
      supabase.from('contractors').select('*, contractor_types(name), contractor_statuses(name, is_active)').eq('id', contractorId).single(),
      supabase.from('contractor_mtd').select('*').eq('contractor_id', contractorId).single(),
      supabase.from('sources').select('*, payment_types(name)').eq('contractor_id', contractorId).order('created_at'),
      supabase.from('weekly_facts').select('*, sources(name)').eq('contractor_id', contractorId).order('week_start', { ascending: false }).limit(20),
      supabase.from('management_decisions').select('*, decision_types(name)').eq('contractor_id', contractorId).order('decision_date', { ascending: false }),
      supabase.from('status_history').select('*, old:old_status_id(name), new:new_status_id(name), reason:reason_id(name)').eq('contractor_id', contractorId).order('changed_at', { ascending: false }),
      supabase.from('invoices').select('*').eq('contractor_id', contractorId).order('created_at', { ascending: false }),
      supabase.from('contractor_files').select('*').eq('contractor_id', contractorId).order('uploaded_at', { ascending: false }),
      supabase.from('payment_types').select('*').order('name'),
      supabase.from('contractor_targets').select('*').eq('contractor_id', contractorId).maybeSingle(),
    ])
    setContractor(c.data)
    setContractorForm(c.data || {})
    setMtd(m.data)
    setSources(s.data || [])
    setFacts(f.data || [])
    setDecisions(d.data || [])
    setStatusHistory(sh.data || [])
    setInvoices(inv.data || [])
    setFiles(fi.data || [])
    setPaymentTypes(pt.data || [])
    setTarget(tg.data || null)
    setTargetForm(tg.data || {})
    // Найти id статуса Архив
    const archiveStatus = (await supabase.from('contractor_statuses').select('id').eq('name', 'Архив').single()).data
    setArchiveStatusId(archiveStatus?.id)
    setLoading(false)
  }

  useEffect(() => { load() }, [contractorId])

  // Сохранить источник (новый или редактирование)
  async function saveSource(source) {
    const payload = {
      name: source.name,
      roistat_marker: source.roistat_marker || null,
      calltracking_phone: source.calltracking_phone || null,
      landing_url: source.landing_url || null,
      payment_type_id: source.payment_type_id ? Number(source.payment_type_id) : null,
      cpl_rate: source.cpl_rate ? Number(source.cpl_rate) : null,
      retainer: source.retainer ? Number(source.retainer) : null,
      ad_budget: source.ad_budget ? Number(source.ad_budget) : null,
      status: source.status || 'активен',
    }
    if (source.id) {
      await supabase.from('sources').update(payload).eq('id', source.id)
    } else {
      await supabase.from('sources').insert({ ...payload, contractor_id: contractorId })
    }
    setEditingSource(null)
    setShowAddSource(false)
    setNewSource({ name: '', roistat_marker: '', calltracking_phone: '', landing_url: '', payment_type_id: '', cpl_rate: '', retainer: '', ad_budget: '' })
    load()
  }

  // Сохранить изменения подрядчика
  async function saveContractor() {
    await supabase.from('contractors').update({
      name: contractorForm.name,
      short_name: contractorForm.short_name,
      responsible_name: contractorForm.responsible_name,
      contact_name: contractorForm.contact_name,
      contact_telegram: contractorForm.contact_telegram,
      contact_phone: contractorForm.contact_phone,
      contact_email: contractorForm.contact_email,
      working_chat_url: contractorForm.working_chat_url,
      comment: contractorForm.comment,
      spend_by_source: contractorForm.spend_by_source,
    }).eq('id', contractorId)
    setEditContractor(false)
    load()
  }

  // Сохранить план подрядчика (ТЗ раздел 5.2) — не месячный, правится вручную по мере необходимости
  async function saveTarget() {
    if (!targetForm.plan_spend || !targetForm.plan_leads || !targetForm.plan_quals || !targetForm.plan_meetings || !targetForm.plan_deals) {
      alert('Заполните все 5 полей плана')
      return
    }
    setTargetSaving(true)
    const payload = {
      contractor_id: contractorId,
      plan_spend: Number(targetForm.plan_spend),
      plan_leads: Number(targetForm.plan_leads),
      plan_quals: Number(targetForm.plan_quals),
      plan_meetings: Number(targetForm.plan_meetings),
      plan_deals: Number(targetForm.plan_deals),
      updated_at: new Date().toISOString(),
      updated_by: targetForm.updated_by || '',
    }
    const { error } = await supabase.from('contractor_targets').upsert(payload, { onConflict: 'contractor_id' })
    setTargetSaving(false)
    if (error) { alert('Ошибка: ' + error.message); return }
    setEditTarget(false)
    load()
  }

  // Загрузка документа (ТЗ раздел 10.2) — только 2 типа, без сроков действия
  async function uploadFile() {
    if (!selectedFile || !uploadedByName) {
      alert('Выберите файл и укажите, кто загружает')
      return
    }
    setUploading(true)
    const path = `${contractorId}/${Date.now()}-${selectedFile.name}`
    const { error: uploadError } = await supabase.storage.from('contractor-files').upload(path, selectedFile)
    if (uploadError) { alert('Ошибка загрузки: ' + uploadError.message); setUploading(false); return }

    const { data: pub } = supabase.storage.from('contractor-files').getPublicUrl(path)
    const { error } = await supabase.from('contractor_files').insert({
      contractor_id: contractorId,
      file_name: selectedFile.name,
      file_url: pub.publicUrl,
      file_type: uploadFileType,
      uploaded_by: uploadedByName,
    })
    setUploading(false)
    if (error) { alert('Ошибка: ' + error.message); return }
    setSelectedFile(null)
    load()
  }

  if (loading) return <div className="loading">Загрузка паспорта...</div>
  if (!contractor) return <div className="loading">Подрядчик не найден</div>

  const status = contractor.contractor_statuses?.name
  const alerts = []
  if (mtd?.cpl_mtd > 1500) alerts.push({ type: 'danger', text: `CPL ${Math.round(mtd.cpl_mtd).toLocaleString('ru-RU')} ₽ — превышен порог (1 500 ₽)` })
  else if (mtd?.cpl_mtd > 1200) alerts.push({ type: 'warning', text: `CPL ${Math.round(mtd.cpl_mtd).toLocaleString('ru-RU')} ₽ — в жёлтой зоне` })
  if (mtd?.spend_mtd > 0 && mtd?.leads_mtd === 0) alerts.push({ type: 'danger', text: 'Есть расход, но нет лидов — аномалия' })

  // Форма редактирования источника
  function SourceForm({ source, onSave, onCancel }) {
    const [form, setForm] = useState(source)
    const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
    return (
      <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 14, marginBottom: 10 }}>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Название <span className="req">*</span></label><input className="form-input" value={form.name || ''} onChange={e => set('name', e.target.value)} /></div>
          <div className="form-group"><label className="form-label">Roistat marker</label><input className="form-input" value={form.roistat_marker || ''} onChange={e => set('roistat_marker', e.target.value)} placeholder="ofbfl-название" /></div>
        </div>
        <div className="form-row">
          <div className="form-group"><label className="form-label">Телефон КТ</label><input className="form-input" value={form.calltracking_phone || ''} onChange={e => set('calltracking_phone', e.target.value)} /></div>
          <div className="form-group"><label className="form-label">Посадочная</label><input className="form-input" value={form.landing_url || ''} onChange={e => set('landing_url', e.target.value)} /></div>
        </div>
        <div style={{ borderTop: '1px solid var(--border)', marginTop: 10, paddingTop: 10 }}>
          <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--text-muted)', textTransform: 'uppercase', marginBottom: 8 }}>Модель оплаты источника</div>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Тип оплаты</label>
              <select className="form-select" value={form.payment_type_id || ''} onChange={e => set('payment_type_id', e.target.value)}>
                <option value="">— не задано —</option>
                {paymentTypes.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            <div className="form-group"><label className="form-label">Ставка CPL (₽)</label><input className="form-input" type="number" value={form.cpl_rate || ''} onChange={e => set('cpl_rate', e.target.value)} placeholder="0" /></div>
          </div>
          <div className="form-row">
            <div className="form-group"><label className="form-label">Абонентка (₽)</label><input className="form-input" type="number" value={form.retainer || ''} onChange={e => set('retainer', e.target.value)} placeholder="0" /></div>
            <div className="form-group"><label className="form-label">Рекл. бюджет (₽)</label><input className="form-input" type="number" value={form.ad_budget || ''} onChange={e => set('ad_budget', e.target.value)} placeholder="0" /></div>
          </div>
        </div>
        {form.id && (
          <div className="form-group">
            <label className="form-label">Статус источника</label>
            <select className="form-select" value={form.status || 'активен'} onChange={e => set('status', e.target.value)}>
              <option value="активен">Активен</option>
              <option value="пауза">Пауза</option>
              <option value="отключён">Отключён</option>
            </select>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
          <button className="btn btn-primary btn-sm" onClick={() => onSave(form)}>Сохранить</button>
          <button className="btn btn-ghost btn-sm" onClick={onCancel}>Отмена</button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <button className="back-btn" onClick={onBack}>← Все подрядчики</button>

      {/* Шапка */}
      <div className="passport-header">
        <div style={{ flex: 1 }}>
          <div className="passport-name">{contractor.name}</div>
          <div className="passport-meta">
            <span className={`badge ${getStatusClass(status)}`}>{status}</span>
            {contractor.contractor_types?.name && <span className="td-muted" style={{ fontSize: 12 }}>{contractor.contractor_types.name}</span>}
            {contractor.responsible_name && <span className="td-muted" style={{ fontSize: 12 }}>👤 {contractor.responsible_name}</span>}
            {contractor.spend_by_source && <span className="badge badge-test" style={{ fontSize: 10 }}>расход по источникам</span>}
          </div>
          {contractor.comment && <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8 }}>{contractor.comment}</div>}
        </div>
        <div className="passport-actions">
          <button className="btn btn-secondary btn-sm" onClick={() => setShowFact(true)}>+ Факт</button>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowDecision(true)}>+ Решение</button>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowStatus(true)}>Статус →</button>
          <button className="btn btn-danger btn-sm" onClick={() => setShowDelete(true)}>🗑</button>
        </div>
      </div>

      {alerts.map((a, i) => (
        <div key={i} className={`alert alert-${a.type}`}>
          {a.type === 'danger' ? '🔴' : '⚠️'} {a.text}
        </div>
      ))}

      <div className="tabs">
        {TABS.map(t => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      {/* ОБЗОР */}
      {tab === 'Обзор' && (
        <div>
          <div className="metric-grid" style={{ marginBottom: 16 }}>
            {[
              { label: 'Лиды МТД', val: mtd?.leads_mtd || 0, type: null },
              { label: 'Расход МТД', val: formatMoney(mtd?.spend_mtd), type: null },
              { label: 'CPL', val: mtd?.cpl_mtd ? formatMoney(mtd.cpl_mtd) : '—', type: 'cpl', raw: mtd?.cpl_mtd, sub: 'порог 1 500 ₽' },
              { label: 'CPQL', val: mtd?.cpql_mtd ? formatMoney(mtd.cpql_mtd) : '—', type: 'cpql', raw: mtd?.cpql_mtd, sub: 'порог 7 500 ₽' },
              { label: 'CAC накопит.', val: mtd?.cac_mtd ? formatMoney(mtd.cac_mtd) : '—', type: 'cac', raw: mtd?.cac_mtd, sub: 'порог 75 000 ₽' },
            ].map(card => (
              <div key={card.label} className={`metric-card ${card.type ? metricCardClass(card.type, card.raw) : 'neutral'}`}>
                <div className="metric-card-label">{card.label}</div>
                <div className="metric-card-value" style={{ fontSize: typeof card.val === 'string' && card.val.length > 8 ? 14 : 20 }}>{card.val}</div>
                {card.sub && <div className="metric-card-sub">{card.sub}</div>}
              </div>
            ))}
          </div>

          {/* План подрядчика (ТЗ раздел 5.2) */}
          <div className="info-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div className="info-card-title" style={{ margin: 0 }}>План подрядчика</div>
              <button className="btn btn-ghost btn-sm" onClick={() => { setTargetForm(target || {}); setEditTarget(!editTarget) }}>
                {target ? '✏️ Редактировать' : '+ Задать план'}
              </button>
            </div>
            {editTarget ? (
              <div>
                <div className="form-row">
                  <div className="form-group"><label className="form-label">Расход (₽)</label><input className="form-input" type="number" value={targetForm.plan_spend || ''} onChange={e => setTargetForm(f => ({ ...f, plan_spend: e.target.value }))} /></div>
                  <div className="form-group"><label className="form-label">Лиды</label><input className="form-input" type="number" value={targetForm.plan_leads || ''} onChange={e => setTargetForm(f => ({ ...f, plan_leads: e.target.value }))} /></div>
                </div>
                <div className="form-row">
                  <div className="form-group"><label className="form-label">Квалы</label><input className="form-input" type="number" value={targetForm.plan_quals || ''} onChange={e => setTargetForm(f => ({ ...f, plan_quals: e.target.value }))} /></div>
                  <div className="form-group"><label className="form-label">Встречи</label><input className="form-input" type="number" value={targetForm.plan_meetings || ''} onChange={e => setTargetForm(f => ({ ...f, plan_meetings: e.target.value }))} /></div>
                </div>
                <div className="form-row">
                  <div className="form-group"><label className="form-label">Сделки</label><input className="form-input" type="number" value={targetForm.plan_deals || ''} onChange={e => setTargetForm(f => ({ ...f, plan_deals: e.target.value }))} /></div>
                  <div className="form-group"><label className="form-label">Кто скорректировал</label><input className="form-input" value={targetForm.updated_by || ''} onChange={e => setTargetForm(f => ({ ...f, updated_by: e.target.value }))} placeholder="Имя" /></div>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={saveTarget} disabled={targetSaving}>{targetSaving ? 'Сохранение...' : 'Сохранить'}</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditTarget(false)}>Отмена</button>
                </div>
              </div>
            ) : target ? (
              <div>
                <div className="info-grid">
                  {[
                    { label: 'Расход', val: formatMoney(target.plan_spend) },
                    { label: 'Лиды', val: target.plan_leads },
                    { label: 'Квалы', val: target.plan_quals },
                    { label: 'Встречи', val: target.plan_meetings },
                    { label: 'Сделки', val: target.plan_deals },
                  ].map(item => (
                    <div key={item.label} className="info-item">
                      <div className="info-item-label">{item.label}</div>
                      <div className="info-item-value">{item.val ?? '—'}</div>
                    </div>
                  ))}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10 }}>
                  Обновлено {formatDate(target.updated_at)}{target.updated_by ? ` · ${target.updated_by}` : ''}
                </div>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: 'var(--text-muted)' }}>
                План не задан — подрядчик не участвует в контроле отклонений на дашборде.
              </div>
            )}
          </div>

          {/* Основная информация */}
          <div className="info-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div className="info-card-title" style={{ margin: 0 }}>Основная информация</div>
              <button className="btn btn-ghost btn-sm" onClick={() => setEditContractor(!editContractor)}>✏️ Редактировать</button>
            </div>
            {editContractor ? (
              <div>
                <div className="form-row">
                  <div className="form-group"><label className="form-label">Название</label><input className="form-input" value={contractorForm.name || ''} onChange={e => setContractorForm(f => ({ ...f, name: e.target.value }))} /></div>
                  <div className="form-group"><label className="form-label">Краткое название</label><input className="form-input" value={contractorForm.short_name || ''} onChange={e => setContractorForm(f => ({ ...f, short_name: e.target.value }))} /></div>
                </div>
                <div className="form-row">
                  <div className="form-group"><label className="form-label">Ответственный</label><input className="form-input" value={contractorForm.responsible_name || ''} onChange={e => setContractorForm(f => ({ ...f, responsible_name: e.target.value }))} /></div>
                  <div className="form-group"><label className="form-label">Контакт</label><input className="form-input" value={contractorForm.contact_name || ''} onChange={e => setContractorForm(f => ({ ...f, contact_name: e.target.value }))} /></div>
                </div>
                <div className="form-row">
                  <div className="form-group"><label className="form-label">Telegram</label><input className="form-input" value={contractorForm.contact_telegram || ''} onChange={e => setContractorForm(f => ({ ...f, contact_telegram: e.target.value }))} /></div>
                  <div className="form-group"><label className="form-label">Телефон</label><input className="form-input" value={contractorForm.contact_phone || ''} onChange={e => setContractorForm(f => ({ ...f, contact_phone: e.target.value }))} /></div>
                </div>
                <div className="form-row">
                  <div className="form-group"><label className="form-label">Email</label><input className="form-input" value={contractorForm.contact_email || ''} onChange={e => setContractorForm(f => ({ ...f, contact_email: e.target.value }))} /></div>
                  <div className="form-group"><label className="form-label">Рабочий чат (ссылка)</label><input className="form-input" value={contractorForm.working_chat_url || ''} onChange={e => setContractorForm(f => ({ ...f, working_chat_url: e.target.value }))} /></div>
                </div>
                <div className="form-group">
                  <label className="form-label">Комментарий</label>
                  <textarea className="form-textarea" value={contractorForm.comment || ''} onChange={e => setContractorForm(f => ({ ...f, comment: e.target.value }))} rows={2} />
                </div>
                <div className="form-group" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <input type="checkbox" id="spend_by_source" checked={contractorForm.spend_by_source || false} onChange={e => setContractorForm(f => ({ ...f, spend_by_source: e.target.checked }))} />
                  <label htmlFor="spend_by_source" style={{ fontSize: 13, cursor: 'pointer' }}>Вводить расход по источникам отдельно</label>
                </div>
                <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={saveContractor}>Сохранить</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditContractor(false)}>Отмена</button>
                </div>
              </div>
            ) : (
              <div className="info-grid">
                {[
                  { label: 'Контакт', val: contractor.contact_name },
                  { label: 'Telegram', val: contractor.contact_telegram },
                  { label: 'Телефон', val: contractor.contact_phone },
                  { label: 'Email', val: contractor.contact_email },
                  { label: 'Ответственный', val: contractor.responsible_name },
                  { label: 'Добавлен', val: formatDate(contractor.created_at) },
                ].map(item => (
                  <div key={item.label} className="info-item">
                    <div className="info-item-label">{item.label}</div>
                    <div className="info-item-value">{item.val || '—'}</div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {decisions.length > 0 && (
            <div className="info-card">
              <div className="info-card-title">Последнее решение</div>
              <div className="timeline-item">
                <div className="timeline-icon">📋</div>
                <div className="timeline-content">
                  <div className="timeline-title">{decisions[0].decision_types?.name || 'Решение'}</div>
                  <div className="timeline-meta">{decisions[0].author} · {formatDate(decisions[0].decision_date)}</div>
                  <div className="timeline-body">{decisions[0].comment}</div>
                  {decisions[0].next_step && <div className="timeline-body" style={{ marginTop: 4, color: 'var(--green-primary)', fontWeight: 500 }}>→ {decisions[0].next_step}</div>}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {/* ИСТОЧНИКИ И ОПЛАТА */}
      {tab === 'Источники и оплата' && (
        <div>
          <div className="info-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div className="info-card-title" style={{ margin: 0 }}>Источники подрядчика</div>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowAddSource(!showAddSource)}>+ Добавить источник</button>
            </div>

            {showAddSource && (
              <SourceForm
                source={newSource}
                onSave={saveSource}
                onCancel={() => setShowAddSource(false)}
              />
            )}

            {sources.length === 0 ? (
              <div className="empty-state" style={{ padding: 24 }}>
                <div className="empty-state-icon">📡</div>
                <h3>Источники не добавлены</h3>
                <p>Добавьте источники чтобы настроить маппинг из Битрикса</p>
              </div>
            ) : (
              <div>
                {sources.map(s => (
                  <div key={s.id}>
                    {editingSource?.id === s.id ? (
                      <SourceForm source={editingSource} onSave={saveSource} onCancel={() => setEditingSource(null)} />
                    ) : (
                      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12, padding: '12px 0', borderBottom: '1px solid var(--border-light)' }}>
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                            <span style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</span>
                            <span className={`badge ${s.status === 'активен' ? 'badge-active' : 'badge-pause'}`}>{s.status}</span>
                            {s.payment_types?.name && <span className="badge badge-test">{s.payment_types.name}</span>}
                          </div>
                          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                            {s.roistat_marker && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>🏷 <code style={{ background: 'var(--bg)', padding: '1px 4px', borderRadius: 3 }}>{s.roistat_marker}</code></span>}
                            {s.calltracking_phone && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>📞 {s.calltracking_phone}</span>}
                            {s.landing_url && <a href={s.landing_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: 'var(--green-primary)' }}>🔗 ссылка ↗</a>}
                            {s.cpl_rate && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>CPL: {formatMoney(s.cpl_rate)}</span>}
                            {s.retainer && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Або: {formatMoney(s.retainer)}</span>}
                            {s.ad_budget && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Бюджет: {formatMoney(s.ad_budget)}</span>}
                          </div>
                        </div>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditingSource({ ...s, payment_type_id: s.payment_type_id || '' })}>✏️</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* ФАКТ */}
      {tab === 'Факт' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button className="btn btn-primary btn-sm" onClick={() => setShowFact(true)}>+ Добавить неделю</button>
          </div>
          <div className="table-wrap">
            {facts.length === 0 ? (
              <div className="empty-state"><div className="empty-state-icon">📅</div><h3>Нет данных</h3><p>Данные появятся после загрузки выгрузки из Битрикса</p></div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Неделя</th>
                    <th>Источник</th>
                    <th style={{ textAlign: 'right' }}>Лиды</th>
                    <th style={{ textAlign: 'right' }}>Расход</th>
                    <th style={{ textAlign: 'right' }}>CPL</th>
                    <th style={{ textAlign: 'right' }}>Квалы</th>
                    <th style={{ textAlign: 'right' }}>CPQL</th>
                    <th style={{ textAlign: 'right' }}>Встречи</th>
                    <th style={{ textAlign: 'right' }}>Сделки</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {facts.map(f => {
                    const cpl = f.leads > 0 ? Math.round(f.spend / f.leads) : null
                    const cpql = f.quals > 0 ? Math.round(f.spend / f.quals) : null
                    return (
                      <tr key={f.id}>
                        <td style={{ fontWeight: 500 }}>{formatDate(f.week_start)}</td>
                        <td className="td-muted">{f.sources?.name || '—'}</td>
                        <td style={{ textAlign: 'right' }}>{f.leads}</td>
                        <td style={{ textAlign: 'right' }}>{formatMoney(f.spend)}</td>
                        <td style={{ textAlign: 'right' }}><span className={`metric ${cplClass(cpl)}`}>{cpl ? formatMoney(cpl) : '—'}</span></td>
                        <td style={{ textAlign: 'right' }}>{f.quals}</td>
                        <td style={{ textAlign: 'right' }}><span className={`metric ${cpqlClass(cpql)}`}>{cpql ? formatMoney(cpql) : '—'}</span></td>
                        <td style={{ textAlign: 'right' }}>{f.meetings}</td>
                        <td style={{ textAlign: 'right' }}>{f.deals}</td>
                        <td><span className={`badge ${f.verify_status === 'проверен' ? 'badge-active' : f.verify_status === 'отклонён' ? 'badge-off' : 'badge-new'}`}>{f.verify_status}</span></td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {/* РЕШЕНИЯ */}
      {tab === 'Решения' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button className="btn btn-primary btn-sm" onClick={() => setShowDecision(true)}>+ Добавить решение</button>
          </div>
          {decisions.length === 0 ? (
            <div className="empty-state"><div className="empty-state-icon">📋</div><h3>Решений нет</h3></div>
          ) : (
            <div className="timeline">
              {decisions.map(d => (
                <div key={d.id} className="timeline-item">
                  <div className="timeline-icon">📋</div>
                  <div className="timeline-content">
                    <div className="timeline-title">{d.decision_types?.name || 'Решение'}</div>
                    <div className="timeline-meta">{d.author} · {formatDate(d.decision_date)}</div>
                    <div className="timeline-body">{d.comment}</div>
                    {d.next_step && <div className="timeline-body" style={{ marginTop: 4, color: 'var(--green-primary)', fontWeight: 500 }}>→ {d.next_step}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* СЧЕТА */}
      {tab === 'Счета' && (
        <div>
          <div className="info-card" style={{ marginBottom: 12 }}>
            <div className="info-card-title">Оплаченные счета</div>
            <div className="alert alert-info">
              ℹ️ Счета загружаются раз в месяц. Формат имени файла: <code>Подрядчик_НаЧто_Направление_Сумма</code>
            </div>
            <div style={{ marginTop: 12, color: 'var(--text-muted)', fontSize: 13 }}>
              Загрузка счетов будет доступна в разделе «Счета» (общий раздел). Здесь отображаются счета привязанные к этому подрядчику.
            </div>
          </div>
          {invoices.length === 0 ? (
            <div className="empty-state"><div className="empty-state-icon">🧾</div><h3>Счетов нет</h3><p>Счета появятся после загрузки в общем разделе</p></div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Файл</th>
                    <th>Назначение</th>
                    <th>Направление</th>
                    <th style={{ textAlign: 'right' }}>Сумма</th>
                    <th>Месяц</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {invoices.map(inv => (
                    <tr key={inv.id}>
                      <td style={{ fontSize: 12 }}>{inv.file_name}</td>
                      <td className="td-muted">{inv.parsed_purpose || '—'}</td>
                      <td className="td-muted">{inv.parsed_direction || '—'}</td>
                      <td style={{ textAlign: 'right', fontWeight: 600 }}>{formatMoney(inv.parsed_amount)}</td>
                      <td className="td-muted">{inv.month ? new Date(inv.month).toLocaleString('ru-RU', { month: 'long', year: 'numeric' }) : '—'}</td>
                      <td><span className={`badge ${inv.status === 'ok' ? 'badge-active' : inv.status === 'not_found' ? 'badge-off' : 'badge-new'}`}>{inv.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* ФАЙЛЫ */}
      {tab === 'Файлы' && (
        <div className="info-card">
          <div className="info-card-title">Документы подрядчика</div>

          <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 14, marginBottom: 16 }}>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">Тип документа</label>
                <select className="form-select" value={uploadFileType} onChange={e => setUploadFileType(e.target.value)}>
                  <option value="Договор">Договор</option>
                  <option value="NDA">NDA</option>
                </select>
              </div>
              <div className="form-group">
                <label className="form-label">Кто загружает <span className="req">*</span></label>
                <input className="form-input" value={uploadedByName} onChange={e => setUploadedByName(e.target.value)} placeholder="Имя" />
              </div>
            </div>
            <div className="form-group">
              <label className="form-label">Файл <span className="req">*</span></label>
              <input className="form-input" type="file" onChange={e => setSelectedFile(e.target.files?.[0] || null)} />
            </div>
            <button className="btn btn-primary btn-sm" onClick={uploadFile} disabled={uploading}>
              {uploading ? 'Загрузка...' : '📤 Загрузить'}
            </button>
          </div>

          {files.length === 0 ? (
            <div className="empty-state" style={{ padding: 24 }}>
              <div className="empty-state-icon">📄</div>
              <h3>Файлов нет</h3>
              <p>Договор и NDA будут здесь</p>
            </div>
          ) : (
            <div className="timeline">
              {files.map(f => (
                <div key={f.id} className="timeline-item">
                  <div className="timeline-icon">📄</div>
                  <div className="timeline-content">
                    <div className="timeline-title">
                      {f.file_type && <span className="badge badge-test" style={{ marginRight: 6 }}>{f.file_type}</span>}
                      {f.file_name}
                    </div>
                    <div className="timeline-meta">{f.uploaded_by} · {formatDate(f.uploaded_at)}</div>
                    {f.file_url && <a href={f.file_url} target="_blank" rel="noreferrer" style={{ fontSize: 12, color: 'var(--green-primary)' }}>Открыть ↗</a>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* ИСТОРИЯ */}
      {tab === 'История' && (
        <div>
          {statusHistory.length === 0 ? (
            <div className="empty-state"><div className="empty-state-icon">🕓</div><h3>История пуста</h3></div>
          ) : (
            <div className="timeline">
              {statusHistory.map(h => (
                <div key={h.id} className="timeline-item">
                  <div className="timeline-icon">🔄</div>
                  <div className="timeline-content">
                    <div className="timeline-title">{h.old?.name || '—'} → {h.new?.name || '—'}</div>
                    <div className="timeline-meta">{h.changed_by} · {formatDate(h.changed_at)}</div>
                    {h.reason?.name && <div className="timeline-body">Причина: {h.reason.name}</div>}
                    {h.comment && <div className="timeline-body">{h.comment}</div>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {showStatus && <ChangeStatusModal contractor={contractor} onClose={() => setShowStatus(false)} onSaved={() => { setShowStatus(false); load() }} />}
      {showDecision && <AddDecisionModal contractorId={contractorId} onClose={() => setShowDecision(false)} onSaved={() => { setShowDecision(false); load() }} />}
      {showFact && <WeeklyFactModal contractorId={contractorId} contractorName={contractor.short_name || contractor.name} onClose={() => setShowFact(false)} onSaved={() => { setShowFact(false); load() }} />}
      {showDelete && <DeleteContractorModal contractor={contractor} archiveStatusId={archiveStatusId} onClose={() => setShowDelete(false)} onDeleted={onBack} onArchived={() => { setShowDelete(false); load() }} />}
    </div>
  )
}
