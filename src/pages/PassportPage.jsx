import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { getStatusClass, formatMoney, formatDate, metricCardClass, ACTIVE_PAYMENT_TYPES } from '../lib/helpers.js'
import ChangeStatusModal from '../components/ChangeStatusModal.jsx'
import AddDecisionModal from '../components/AddDecisionModal.jsx'
import DeleteContractorModal from '../components/DeleteContractorModal.jsx'

// Вкладка «Расход» удалена (ТЗ раздел 8.2) — ввод расхода переехал в отдельный
// раздел «Ввод расходов» (src/pages/WeeklyExpensesPage.jsx), не в паспорт.
// Вкладки «Факт», «Счета», «История» убраны по запросу — упрощение паспорта.
const TABS = ['Обзор', 'Источники и оплата', 'Решения', 'Файлы']

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
  const [decisions, setDecisions] = useState([])
  const [files, setFiles] = useState([])
  const [loading, setLoading] = useState(true)
  const [showStatus, setShowStatus] = useState(false)
  const [showDecision, setShowDecision] = useState(false)
  const [editingSource, setEditingSource] = useState(null)
  const [deletingSource, setDeletingSource] = useState(null)
  const [deleteFactsCount, setDeleteFactsCount] = useState(0)
  const [deleteAction, setDeleteAction] = useState('delete')
  const [reassignTargetId, setReassignTargetId] = useState('')
  const [deletingLoading, setDeletingLoading] = useState(false)
  const [allSources, setAllSources] = useState([])
  const [showAddSource, setShowAddSource] = useState(false)
  const [newSource, setNewSource] = useState({ name: '', roistat_marker: '', calltracking_phone: '', landing_url: '', payment_type_id: '', cpl_rate: '', retainer: '' })
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
    const [c, m, s, d, fi, pt, tg] = await Promise.all([
      supabase.from('contractors').select('*, contractor_types(name), contractor_statuses(name, is_active)').eq('id', contractorId).single(),
      supabase.from('contractor_mtd').select('*').eq('contractor_id', contractorId).single(),
      supabase.from('sources').select('*, payment_types(name)').eq('contractor_id', contractorId).order('created_at'),
      supabase.from('management_decisions').select('*, decision_types(name)').eq('contractor_id', contractorId).order('decision_date', { ascending: false }),
      supabase.from('contractor_files').select('*').eq('contractor_id', contractorId).order('uploaded_at', { ascending: false }),
      supabase.from('payment_types').select('*').order('name'),
      supabase.from('contractor_targets').select('*').eq('contractor_id', contractorId).maybeSingle(),
    ])
    setContractor(c.data)
    setContractorForm(c.data || {})
    setMtd(m.data)
    setSources(s.data || [])
    setDecisions(d.data || [])
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
      status: source.status || 'активен',
    }
    if (source.id) {
      await supabase.from('sources').update(payload).eq('id', source.id)
    } else {
      await supabase.from('sources').insert({ ...payload, contractor_id: contractorId })
    }
    setEditingSource(null)
    setShowAddSource(false)
    setNewSource({ name: '', roistat_marker: '', calltracking_phone: '', landing_url: '', payment_type_id: '', cpl_rate: '', retainer: '' })
    load()
  }

  // Начать удаление источника — сначала смотрим, сколько заявок за ним закреплено
  async function startDeleteSource(source) {
    const [{ count }, { data: everySource }] = await Promise.all([
      supabase.from('daily_facts').select('id', { count: 'exact', head: true }).eq('source_id', source.id),
      // Перенос заявок доступен на источник ЛЮБОГО подрядчика — привязка источника
      // к подрядчику иногда сделана неверно, и это единственный способ её исправить.
      supabase.from('sources').select('id, name, contractor_id, contractors(short_name, name)').order('name'),
    ])
    setDeleteFactsCount(count || 0)
    setAllSources(everySource || [])
    setDeletingSource(source)
    setDeleteAction('delete')
    setReassignTargetId('')
  }

  // Подтвердить удаление: заявки либо удаляются вместе с источником, либо
  // переносятся на другой источник (в том числе другого подрядчика — если
  // привязка изначально была сделана неверно). При переносе на источник другого
  // подрядчика contractor_id у заявок меняется вместе с source_id, иначе они
  // "потеряются" между дашбордом одного подрядчика и источником другого.
  // Расход, введённый за удаляемым источником, переносу не подлежит и удаляется вместе с ним.
  async function confirmDeleteSource() {
    if (!deletingSource) return
    if (deleteFactsCount > 0 && deleteAction === 'reassign' && !reassignTargetId) {
      alert('Выберите источник, на который перенести заявки')
      return
    }
    setDeletingLoading(true)
    if (deleteFactsCount > 0) {
      if (deleteAction === 'reassign') {
        const target = allSources.find(s => s.id === reassignTargetId)
        await supabase.from('daily_facts')
          .update({ source_id: reassignTargetId, contractor_id: target?.contractor_id || null })
          .eq('source_id', deletingSource.id)
      } else {
        await supabase.from('daily_facts').delete().eq('source_id', deletingSource.id)
      }
    }
    await supabase.from('weekly_expenses').delete().eq('source_id', deletingSource.id)
    await supabase.from('sources').delete().eq('id', deletingSource.id)
    setDeletingLoading(false)
    setDeletingSource(null)
    load()
  }

  // Сохранить изменения подрядчика
  async function saveContractor() {
    await supabase.from('contractors').update({
      name: contractorForm.name,
      contact_name: contractorForm.contact_name,
      working_chat_url: contractorForm.working_chat_url,
      comment: contractorForm.comment,
    }).eq('id', contractorId)
    setEditContractor(false)
    load()
  }

  // Сохранить план подрядчика (ТЗ раздел 5.2) — не месячный, правится вручную по мере необходимости.
  // Квалы/встречи/сделки не вводятся напрямую — считаются цепочкой конверсий от лидов.
  async function saveTarget() {
    if (!targetForm.plan_spend || !targetForm.plan_leads || !targetForm.plan_cr_lq || !targetForm.plan_cr_qm || !targetForm.plan_cr_mo) {
      alert('Заполните расход, лиды и все 3 конверсии')
      return
    }
    setTargetSaving(true)
    const planLeadsNum = Number(targetForm.plan_leads)
    const planQualsCalc = Math.round(planLeadsNum * Number(targetForm.plan_cr_lq) / 100)
    const planMeetingsCalc = Math.round(planQualsCalc * Number(targetForm.plan_cr_qm) / 100)
    const planDealsCalc = Math.round(planMeetingsCalc * Number(targetForm.plan_cr_mo) / 100)
    const payload = {
      contractor_id: contractorId,
      plan_spend: Number(targetForm.plan_spend),
      plan_leads: planLeadsNum,
      plan_cr_lq: Number(targetForm.plan_cr_lq),
      plan_cr_qm: Number(targetForm.plan_cr_qm),
      plan_cr_mo: Number(targetForm.plan_cr_mo),
      plan_quals: planQualsCalc,
      plan_meetings: planMeetingsCalc,
      plan_deals: planDealsCalc,
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
    // Ключ объекта в Storage должен быть ASCII-safe (кириллица и пробелы дают
    // "Invalid key") — генерируем безопасный путь, оригинальное имя файла
    // сохраняем отдельно в file_name только для отображения.
    const extMatch = selectedFile.name.match(/\.[^.]+$/)
    const ext = extMatch ? extMatch[0].replace(/[^a-zA-Z0-9.]/g, '') : ''
    const safeId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const path = `${contractorId}/${safeId}${ext}`
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
    const selectedTypeName = paymentTypes.find(p => String(p.id) === String(form.payment_type_id))?.name
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
                {paymentTypes.filter(p => ACTIVE_PAYMENT_TYPES.includes(p.name)).map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            {selectedTypeName === 'Фикс' && (
              <div className="form-group"><label className="form-label">Ставка CPL (₽)</label><input className="form-input" type="number" value={form.cpl_rate || ''} onChange={e => set('cpl_rate', e.target.value)} placeholder="0" /></div>
            )}
          </div>
          <div className="form-group"><label className="form-label">Абонентка (₽)</label><input className="form-input" type="number" value={form.retainer || ''} onChange={e => set('retainer', e.target.value)} placeholder="0" /></div>
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
                  <div className="form-group"><label className="form-label">CR лид → квал (%)</label><input className="form-input" type="number" value={targetForm.plan_cr_lq || ''} onChange={e => setTargetForm(f => ({ ...f, plan_cr_lq: e.target.value }))} placeholder="20" /></div>
                  <div className="form-group"><label className="form-label">CR квал → встреча (%)</label><input className="form-input" type="number" value={targetForm.plan_cr_qm || ''} onChange={e => setTargetForm(f => ({ ...f, plan_cr_qm: e.target.value }))} placeholder="55" /></div>
                </div>
                <div className="form-row">
                  <div className="form-group"><label className="form-label">CR встреча → сделка (%)</label><input className="form-input" type="number" value={targetForm.plan_cr_mo || ''} onChange={e => setTargetForm(f => ({ ...f, plan_cr_mo: e.target.value }))} placeholder="15" /></div>
                  <div className="form-group"><label className="form-label">Кто скорректировал</label><input className="form-input" value={targetForm.updated_by || ''} onChange={e => setTargetForm(f => ({ ...f, updated_by: e.target.value }))} placeholder="Имя" /></div>
                </div>
                {(() => {
                  const leadsN = Number(targetForm.plan_leads) || 0
                  const qualsCalc = Math.round(leadsN * (Number(targetForm.plan_cr_lq) || 0) / 100)
                  const meetingsCalc = Math.round(qualsCalc * (Number(targetForm.plan_cr_qm) || 0) / 100)
                  const dealsCalc = Math.round(meetingsCalc * (Number(targetForm.plan_cr_mo) || 0) / 100)
                  return (
                    <div className="form-hint" style={{ marginBottom: 8 }}>
                      Квалы: <strong>{qualsCalc}</strong> · Встречи: <strong>{meetingsCalc}</strong> · Сделки: <strong>{dealsCalc}</strong>
                    </div>
                  )
                })()}
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
                    { label: 'CR л→кв', val: target.plan_cr_lq != null ? `${target.plan_cr_lq}%` : null },
                    { label: 'Квалы', val: target.plan_quals },
                    { label: 'CR кв→вс', val: target.plan_cr_qm != null ? `${target.plan_cr_qm}%` : null },
                    { label: 'Встречи', val: target.plan_meetings },
                    { label: 'CR вс→сд', val: target.plan_cr_mo != null ? `${target.plan_cr_mo}%` : null },
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
                <div className="form-group">
                  <label className="form-label">Название</label><input className="form-input" value={contractorForm.name || ''} onChange={e => setContractorForm(f => ({ ...f, name: e.target.value }))} />
                </div>
                <div className="form-row">
                  <div className="form-group"><label className="form-label">Контакт</label><input className="form-input" value={contractorForm.contact_name || ''} onChange={e => setContractorForm(f => ({ ...f, contact_name: e.target.value }))} /></div>
                  <div className="form-group"><label className="form-label">Рабочий чат (ссылка)</label><input className="form-input" value={contractorForm.working_chat_url || ''} onChange={e => setContractorForm(f => ({ ...f, working_chat_url: e.target.value }))} /></div>
                </div>
                <div className="form-group">
                  <label className="form-label">Комментарий</label>
                  <textarea className="form-textarea" value={contractorForm.comment || ''} onChange={e => setContractorForm(f => ({ ...f, comment: e.target.value }))} rows={2} />
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
                  { label: 'Рабочий чат', val: contractor.working_chat_url },
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
                    ) : deletingSource?.id === s.id ? (
                      <div style={{ background: '#fdf2f2', border: '1px solid #f5c6c6', borderRadius: 'var(--radius)', padding: 14, marginBottom: 4 }}>
                        <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>Удалить источник «{s.name}»?</div>
                        {deleteFactsCount === 0 ? (
                          <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 10 }}>Заявок за этим источником нет.</div>
                        ) : (
                          <div style={{ marginBottom: 10 }}>
                            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                              За этим источником закреплено <strong>{deleteFactsCount}</strong> {deleteFactsCount === 1 ? 'заявка' : 'заявок'}. Что с ними сделать?
                            </div>
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                                <input type="radio" checked={deleteAction === 'delete'} onChange={() => setDeleteAction('delete')} />
                                Удалить вместе с источником ({deleteFactsCount})
                              </label>
                              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13, cursor: 'pointer' }}>
                                <input type="radio" checked={deleteAction === 'reassign'} onChange={() => setDeleteAction('reassign')} />
                                Перенести на другой источник (в том числе другого подрядчика)
                              </label>
                              {deleteAction === 'reassign' && (
                                <select className="form-select" style={{ marginLeft: 22, maxWidth: 320 }} value={reassignTargetId} onChange={e => setReassignTargetId(e.target.value)}>
                                  <option value="">— выберите источник —</option>
                                  {allSources.filter(other => other.id !== s.id).map(other => (
                                    <option key={other.id} value={other.id}>
                                      {(other.contractors?.short_name || other.contractors?.name || '—')} · {other.name}
                                    </option>
                                  ))}
                                </select>
                              )}
                            </div>
                          </div>
                        )}
                        <div style={{ display: 'flex', gap: 8 }}>
                          <button className="btn btn-danger btn-sm" onClick={confirmDeleteSource} disabled={deletingLoading}>
                            {deletingLoading ? 'Удаление...' : 'Подтвердить удаление'}
                          </button>
                          <button className="btn btn-ghost btn-sm" onClick={() => setDeletingSource(null)}>Отмена</button>
                        </div>
                      </div>
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
                          </div>
                        </div>
                        <button className="btn btn-ghost btn-sm" onClick={() => setEditingSource({ ...s, payment_type_id: s.payment_type_id || '' })}>✏️</button>
                        <button className="btn btn-ghost btn-sm" onClick={() => startDeleteSource(s)}>🗑</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
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

      {showStatus && <ChangeStatusModal contractor={contractor} onClose={() => setShowStatus(false)} onSaved={() => { setShowStatus(false); load() }} />}
      {showDecision && <AddDecisionModal contractorId={contractorId} onClose={() => setShowDecision(false)} onSaved={() => { setShowDecision(false); load() }} />}
      {showDelete && <DeleteContractorModal contractor={contractor} archiveStatusId={archiveStatusId} onClose={() => setShowDelete(false)} onDeleted={onBack} onArchived={() => { setShowDelete(false); load() }} />}
    </div>
  )
}
