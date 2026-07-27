import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { getStatusClass, formatMoney, formatDate, ACTIVE_PAYMENT_TYPES } from '../lib/helpers.js'
import { weekStart as getWeekStart, todayISO, addDaysISO, daysBetweenISO, weekStartOf } from '../lib/dateContext.js'
import ChangeStatusModal from '../components/ChangeStatusModal.jsx'
import AddDecisionModal from '../components/AddDecisionModal.jsx'
import DeleteContractorModal from '../components/DeleteContractorModal.jsx'

// Системный импорт данных через приложение начался с 16 июля 2026 — выбор
// произвольного диапазона дат в "Показателях подрядчика" раньше этой даты
// не имеет смысла (данных нет). Та же граница, что и в ContractorsPage.
const MIN_RANGE_DATE = '2026-07-16'

function monthKey(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`
}
function monthLabel(dateStr) {
  return new Date(dateStr).toLocaleString('ru-RU', { month: 'long', year: 'numeric' })
}
function nextMonth(m) {
  const d = new Date(m)
  d.setMonth(d.getMonth() + 1)
  return monthKey(d)
}
function getISOWeek(date) {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()))
  const dayNum = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() + 4 - dayNum)
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1))
  return Math.ceil((((d - yearStart) / 86400000) + 1) / 7)
}
function weekLabel(dateStr) {
  const d = new Date(dateStr)
  const isCurrent = dateStr === getWeekStart()
  return `${getISOWeek(d)} неделя ${d.getFullYear()}${isCurrent ? ' (текущая)' : ''}`
}
function formatRangeDate(iso) {
  return new Date(iso).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
}

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

export default function PassportPage({ contractorId, onBack, isAdmin }) {
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
  const [groupSelecting, setGroupSelecting] = useState(false)
  const [groupPicks, setGroupPicks] = useState([])
  const [groupSaving, setGroupSaving] = useState(false)

  // Показатели подрядчика (Обзор) — свой выбор периода (месяц/неделя/период),
  // независимый от других вкладок/страниц.
  const [pMode, setPMode] = useState('week')
  const [pWeek, setPWeek] = useState(getWeekStart())
  const [pMonth, setPMonth] = useState(monthKey())
  const [pRangeFrom, setPRangeFrom] = useState(MIN_RANGE_DATE)
  const [pRangeTo, setPRangeTo] = useState(todayISO())
  const [pAvailableWeeks, setPAvailableWeeks] = useState([])
  const [pAvailableMonths, setPAvailableMonths] = useState([])
  const [pWeeklyStats, setPWeeklyStats] = useState([])
  const [pDailyFacts, setPDailyFacts] = useState([])
  const [pExpenses, setPExpenses] = useState([])
  const [pFrom, setPFrom] = useState(null)
  const [pTo, setPTo] = useState(null)
  const [pLoading, setPLoading] = useState(false)
  const [sourcesExpanded, setSourcesExpanded] = useState(false)

  async function load() {
    setLoading(true)
    const [c, m, s, d, fi, pt, tg, ws] = await Promise.all([
      supabase.from('contractors').select('*, contractor_types(name), contractor_statuses(name, is_active)').eq('id', contractorId).single(),
      supabase.from('contractor_mtd').select('*').eq('contractor_id', contractorId).single(),
      supabase.from('sources').select('*, payment_types(name)').eq('contractor_id', contractorId).order('created_at'),
      supabase.from('management_decisions').select('*, decision_types(name)').eq('contractor_id', contractorId).order('decision_date', { ascending: false }),
      supabase.from('contractor_files').select('*').eq('contractor_id', contractorId).order('uploaded_at', { ascending: false }),
      supabase.from('payment_types').select('*').order('name'),
      supabase.from('contractor_targets').select('*').eq('contractor_id', contractorId).maybeSingle(),
      supabase.from('weekly_stats').select('week_start').eq('contractor_id', contractorId),
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

    const wsRows = ws.data || []
    setPWeeklyStats(wsRows)
    const weeks = [...new Set(wsRows.map(r => r.week_start))].sort((a, b) => b.localeCompare(a))
    setPAvailableWeeks(weeks)
    if (weeks.length > 0 && !weeks.includes(pWeek)) setPWeek(weeks[0])
    const now = new Date()
    const futureMonths = [0, 1, 2].map(offset => monthKey(new Date(now.getFullYear(), now.getMonth() + offset, 1)))
    const months = [...new Set([...futureMonths, ...weeks.map(w => monthKey(new Date(w)))])].sort((a, b) => b.localeCompare(a))
    setPAvailableMonths(months)

    // Найти id статуса Архив
    const archiveStatus = (await supabase.from('contractor_statuses').select('id').eq('name', 'Архив').single()).data
    setArchiveStatusId(archiveStatus?.id)
    setLoading(false)
  }

  useEffect(() => { load() }, [contractorId])

  // Показатели подрядчика за выбранный период — daily_facts (реальные
  // ежедневные факты, дают разбивку по источникам) + weekly_expenses
  // (расход фиксируется только понедельно, для месяца/произвольного периода
  // прорируется по дням — та же логика, что и в ContractorsPage).
  useEffect(() => {
    if (!contractorId) return
    async function loadPeriodData() {
      setPLoading(true)
      let from, to
      if (pMode === 'week') {
        from = pWeek
        to = addDaysISO(pWeek, 6)
      } else if (pMode === 'month') {
        const weeksInMonth = pWeeklyStats
          .filter(r => r.week_start >= pMonth && r.week_start < nextMonth(pMonth))
          .map(r => r.week_start)
          .sort()
        if (weeksInMonth.length > 0) {
          from = weeksInMonth[0]
          to = addDaysISO(weeksInMonth[weeksInMonth.length - 1], 6)
        } else {
          from = pMonth
          to = addDaysISO(nextMonth(pMonth), -1)
        }
      } else {
        from = pRangeFrom < MIN_RANGE_DATE ? MIN_RANGE_DATE : pRangeFrom
        to = pRangeTo < from ? from : pRangeTo
      }
      const [{ data: facts }, { data: exp }] = await Promise.all([
        supabase.from('daily_facts')
          .select('source_id, leads, quals, meetings, deals, revenue, duplicates')
          .eq('contractor_id', contractorId)
          .gte('fact_date', from)
          .lte('fact_date', to),
        supabase.from('weekly_expenses')
          .select('week_start, spend')
          .eq('contractor_id', contractorId)
          .gte('week_start', weekStartOf(from))
          .lte('week_start', weekStartOf(to)),
      ])
      setPDailyFacts(facts || [])
      setPExpenses(exp || [])
      setPFrom(from)
      setPTo(to)
      setPLoading(false)
    }
    loadPeriodData()
  }, [contractorId, pMode, pWeek, pMonth, pRangeFrom, pRangeTo, pWeeklyStats])

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

  // Объединение источников для расхода (не путать с удалением/переносом
  // заявок выше) — несколько источников с ОДИНАКОВЫМ типом оплаты можно
  // объединить в одну строку на странице "Ввод расходов". expense_group_id —
  // просто общий сгенерированный uuid у всех участников группы.
  function toggleGroupPick(sourceId) {
    setGroupPicks(picks => picks.includes(sourceId) ? picks.filter(id => id !== sourceId) : [...picks, sourceId])
  }

  async function confirmGroup() {
    if (groupPicks.length < 2) return
    setGroupSaving(true)
    const groupId = crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`
    await supabase.from('sources').update({ expense_group_id: groupId }).in('id', groupPicks)
    setGroupSaving(false)
    setGroupPicks([])
    setGroupSelecting(false)
    load()
  }

  async function ungroupSources(groupId) {
    if (!window.confirm('Разгруппировать источники? Расход по ним снова нужно будет вводить отдельно.')) return
    await supabase.from('sources').update({ expense_group_id: null }).eq('expense_group_id', groupId).eq('contractor_id', contractorId)
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

  // Источники, выбранные для объединения, должны быть с одинаковым типом
  // оплаты — иначе авто-расчёт расхода по разным формулам смешается в одну строку.
  const groupPickSources = sources.filter(s => groupPicks.includes(s.id))
  const groupPickTypeId = groupPickSources[0]?.payment_type_id ?? null
  const groupPickValid = groupPicks.length >= 2 && groupPickSources.every(s => s.payment_type_id && s.payment_type_id === groupPickTypeId)

  // Показатели подрядчика за выбранный период — суммарно по всем источникам.
  const pAgg = { leads: 0, quals: 0, meetings: 0, deals: 0, revenue: 0, duplicates: 0, spend: 0 }
  for (const r of pDailyFacts) {
    pAgg.leads += r.leads || 0
    pAgg.quals += r.quals || 0
    pAgg.meetings += r.meetings || 0
    pAgg.deals += r.deals || 0
    pAgg.revenue += Number(r.revenue) || 0
    pAgg.duplicates += r.duplicates || 0
  }
  // Расход фиксируется только понедельно — прорируем по дням, попавшим в
  // выбранный период (для целой недели/месяца доля равна 1, для произвольного
  // диапазона учитывает только пересечение с ним).
  const pExpByWeek = {}
  for (const e of pExpenses) pExpByWeek[e.week_start] = (pExpByWeek[e.week_start] || 0) + (Number(e.spend) || 0)
  if (pFrom && pTo) {
    for (const weekStart in pExpByWeek) {
      const weekEnd = addDaysISO(weekStart, 6)
      const overlapStart = weekStart > pFrom ? weekStart : pFrom
      const overlapEnd = weekEnd < pTo ? weekEnd : pTo
      const overlapDays = daysBetweenISO(overlapStart, overlapEnd) + 1
      if (overlapDays <= 0) continue
      pAgg.spend += (pExpByWeek[weekStart] / 7) * overlapDays
    }
  }
  const pRates = {
    cpl: pAgg.leads > 0 ? Math.round(pAgg.spend / pAgg.leads) : null,
    cpql: pAgg.quals > 0 ? Math.round(pAgg.spend / pAgg.quals) : null,
    cpm: pAgg.meetings > 0 ? Math.round(pAgg.spend / pAgg.meetings) : null,
    cac: pAgg.deals > 0 ? Math.round(pAgg.spend / pAgg.deals) : null,
    cr_lq: pAgg.leads > 0 ? Math.round((pAgg.quals / pAgg.leads) * 1000) / 10 : null,
    cr_qm: pAgg.quals > 0 ? Math.round((pAgg.meetings / pAgg.quals) * 1000) / 10 : null,
    cr_lo: pAgg.leads > 0 ? Math.round((pAgg.deals / pAgg.leads) * 1000) / 10 : null,
    aov: pAgg.deals > 0 ? Math.round(pAgg.revenue / pAgg.deals) : null,
    dup_rate: pAgg.leads > 0 ? Math.round((pAgg.duplicates / pAgg.leads) * 1000) / 10 : null,
  }

  // Разбивка по источникам — только количественные показатели и конверсии,
  // без цен (расход/CPL и т.п. по отдельным источникам не показываем).
  const pBySource = {}
  for (const r of pDailyFacts) {
    const key = r.source_id || 'unknown'
    if (!pBySource[key]) pBySource[key] = { leads: 0, quals: 0, meetings: 0, deals: 0 }
    pBySource[key].leads += r.leads || 0
    pBySource[key].quals += r.quals || 0
    pBySource[key].meetings += r.meetings || 0
    pBySource[key].deals += r.deals || 0
  }
  const pSourceNameMap = {}
  for (const s of sources) pSourceNameMap[s.id] = s.name
  const pSourceRows = Object.entries(pBySource).map(([id, a]) => ({
    id,
    name: pSourceNameMap[id] || 'Без источника',
    ...a,
    cr_lq: a.leads > 0 ? Math.round((a.quals / a.leads) * 1000) / 10 : null,
    cr_qm: a.quals > 0 ? Math.round((a.meetings / a.quals) * 1000) / 10 : null,
    cr_lo: a.leads > 0 ? Math.round((a.deals / a.leads) * 1000) / 10 : null,
  })).sort((a, b) => b.leads - a.leads)

  const pPeriodLabel = pMode === 'month'
    ? monthLabel(pMonth)
    : pMode === 'week'
      ? weekLabel(pWeek)
      : (pFrom && pTo ? `${formatRangeDate(pFrom)} – ${formatRangeDate(pTo)}` : '')

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
        {isAdmin && (
          <div className="passport-actions">
            <button className="btn btn-secondary btn-sm" onClick={() => setShowDecision(true)}>+ Решение</button>
            <button className="btn btn-secondary btn-sm" onClick={() => setShowStatus(true)}>Статус →</button>
            <button className="btn btn-danger btn-sm" onClick={() => setShowDelete(true)}>🗑</button>
          </div>
        )}
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
          {/* План подрядчика (ТЗ раздел 5.2) */}
          <div className="info-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div className="info-card-title" style={{ margin: 0 }}>План подрядчика</div>
              {isAdmin && (
                <button className="btn btn-ghost btn-sm" onClick={() => { setTargetForm(target || {}); setEditTarget(!editTarget) }}>
                  {target ? '✏️ Редактировать' : '+ Задать план'}
                </button>
              )}
            </div>
            {editTarget && isAdmin ? (
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

          {/* Показатели подрядчика — совокупно по всем источникам, за выбранный период */}
          <div className="info-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14, flexWrap: 'wrap', gap: 10 }}>
              <div className="info-card-title" style={{ margin: 0 }}>Показатели подрядчика</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <div style={{ display: 'flex', background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 24, padding: 3 }}>
                  {['month', 'week', 'range'].map(m => (
                    <button key={m} onClick={() => setPMode(m)} style={{
                      padding: '5px 14px', borderRadius: 20, border: 'none', fontSize: 12, fontWeight: 500, cursor: 'pointer',
                      background: pMode === m ? 'var(--green-dark)' : 'transparent',
                      color: pMode === m ? '#fff' : 'var(--text-secondary)',
                    }}>{m === 'month' ? 'Месяц' : m === 'week' ? 'Неделя' : 'Период'}</button>
                  ))}
                </div>
                {pMode === 'month' ? (
                  <select className="form-select" style={{ minWidth: 170 }} value={pMonth} onChange={e => setPMonth(e.target.value)}>
                    {pAvailableMonths.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
                  </select>
                ) : pMode === 'week' ? (
                  <select className="form-select" style={{ minWidth: 170 }} value={pWeek} onChange={e => setPWeek(e.target.value)}>
                    {pAvailableWeeks.length === 0
                      ? <option value={getWeekStart()}>{weekLabel(getWeekStart())}</option>
                      : pAvailableWeeks.map(w => <option key={w} value={w}>{weekLabel(w)}</option>)}
                  </select>
                ) : (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    <input type="date" className="form-select" style={{ minWidth: 130 }} value={pRangeFrom} min={MIN_RANGE_DATE} max={pRangeTo} onChange={e => setPRangeFrom(e.target.value)} />
                    <span style={{ color: 'var(--text-muted)' }}>—</span>
                    <input type="date" className="form-select" style={{ minWidth: 130 }} value={pRangeTo} min={pRangeFrom} max={todayISO()} onChange={e => setPRangeTo(e.target.value)} />
                  </div>
                )}
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'var(--text-muted)', marginBottom: 10 }}>{pPeriodLabel}</div>

            {pLoading ? (
              <div className="loading">Загрузка...</div>
            ) : (
              <>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))', gap: 10 }}>
                  {[
                    { label: 'Расход', val: formatMoney(pAgg.spend) },
                    { label: 'Лиды', val: pAgg.leads },
                    { label: 'CPL', val: pRates.cpl ? formatMoney(pRates.cpl) : '—' },
                    { label: 'Квалы', val: pAgg.quals },
                    { label: 'CR(l→q)', val: pRates.cr_lq != null ? `${pRates.cr_lq}%` : '—' },
                    { label: 'CPQL', val: pRates.cpql ? formatMoney(pRates.cpql) : '—' },
                    { label: 'Встречи', val: pAgg.meetings },
                    { label: 'CPM', val: pRates.cpm ? formatMoney(pRates.cpm) : '—' },
                    { label: 'CR(q→m)', val: pRates.cr_qm != null ? `${pRates.cr_qm}%` : '—' },
                    { label: 'Сделки', val: pAgg.deals },
                    { label: 'CAC', val: pRates.cac ? formatMoney(pRates.cac) : '—' },
                    { label: 'CR(l→o)', val: pRates.cr_lo != null ? `${pRates.cr_lo}%` : '—' },
                    { label: 'Revenue', val: formatMoney(pAgg.revenue) },
                    { label: 'AOV', val: pRates.aov ? formatMoney(pRates.aov) : '—' },
                    { label: 'Дубли', val: pAgg.duplicates },
                    { label: '% дублей', val: pRates.dup_rate != null ? `${pRates.dup_rate}%` : '—' },
                  ].map(item => (
                    <div key={item.label} style={{ background: 'var(--bg)', borderRadius: 'var(--radius)', padding: '10px 12px' }}>
                      <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{item.label}</div>
                      <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>{item.val}</div>
                    </div>
                  ))}
                </div>

                {sources.length > 1 && (
                  <div style={{ marginTop: 14 }}>
                    <button className="btn btn-ghost btn-sm" onClick={() => setSourcesExpanded(v => !v)}>
                      {sourcesExpanded ? '▴ Свернуть по источникам' : '▾ Показатели по источникам'}
                    </button>
                    {sourcesExpanded && (
                      <div style={{ marginTop: 10, overflowX: 'auto' }}>
                        <table className="table-compact">
                          <thead>
                            <tr>
                              <th>Источник</th>
                              <th style={{ textAlign: 'right' }}>Лиды</th>
                              <th style={{ textAlign: 'right' }}>Квалы</th>
                              <th style={{ textAlign: 'right' }}>CR(l→q)</th>
                              <th style={{ textAlign: 'right' }}>Встречи</th>
                              <th style={{ textAlign: 'right' }}>CR(q→m)</th>
                              <th style={{ textAlign: 'right' }}>Сделки</th>
                              <th style={{ textAlign: 'right' }}>CR(l→o)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {pSourceRows.length === 0 ? (
                              <tr><td colSpan={8} className="td-muted" style={{ textAlign: 'center', padding: 12 }}>Нет данных за период</td></tr>
                            ) : pSourceRows.map(row => (
                              <tr key={row.id}>
                                <td>{row.name}</td>
                                <td style={{ textAlign: 'right' }}>{row.leads}</td>
                                <td style={{ textAlign: 'right' }}>{row.quals}</td>
                                <td style={{ textAlign: 'right' }} className="td-muted">{row.cr_lq != null ? `${row.cr_lq}%` : '—'}</td>
                                <td style={{ textAlign: 'right' }}>{row.meetings}</td>
                                <td style={{ textAlign: 'right' }} className="td-muted">{row.cr_qm != null ? `${row.cr_qm}%` : '—'}</td>
                                <td style={{ textAlign: 'right' }}>{row.deals}</td>
                                <td style={{ textAlign: 'right' }} className="td-muted">{row.cr_lo != null ? `${row.cr_lo}%` : '—'}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    )}
                  </div>
                )}
              </>
            )}
          </div>

          {/* Основная информация */}
          <div className="info-card">
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
              <div className="info-card-title" style={{ margin: 0 }}>Основная информация</div>
              {isAdmin && <button className="btn btn-ghost btn-sm" onClick={() => setEditContractor(!editContractor)}>✏️ Редактировать</button>}
            </div>
            {editContractor && isAdmin ? (
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
              {isAdmin && (
                <div style={{ display: 'flex', gap: 8 }}>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => { setGroupSelecting(g => !g); setGroupPicks([]) }}
                  >
                    {groupSelecting ? 'Отмена' : '🔗 Объединить для расхода'}
                  </button>
                  <button className="btn btn-secondary btn-sm" onClick={() => setShowAddSource(!showAddSource)}>+ Добавить источник</button>
                </div>
              )}
            </div>

            {groupSelecting && (
              <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 12, marginBottom: 12 }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 6 }}>
                  Отметь 2 и более источника с одинаковым типом оплаты — на странице «Ввод расходов» они схлопнутся в одну строку.
                </div>
                {groupPicks.length > 0 && !groupPickValid && (
                  <div style={{ fontSize: 12, color: 'var(--red)', marginBottom: 6 }}>
                    Выбранные источники должны быть с одинаковым типом оплаты (и он должен быть задан).
                  </div>
                )}
                <button className="btn btn-primary btn-sm" onClick={confirmGroup} disabled={!groupPickValid || groupSaving}>
                  {groupSaving ? 'Сохранение...' : `Объединить (${groupPicks.length})`}
                </button>
              </div>
            )}

            {showAddSource && isAdmin && (
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
                    {editingSource?.id === s.id && isAdmin ? (
                      <SourceForm source={editingSource} onSave={saveSource} onCancel={() => setEditingSource(null)} />
                    ) : deletingSource?.id === s.id && isAdmin ? (
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
                        {groupSelecting && (
                          <input
                            type="checkbox"
                            style={{ marginTop: 3 }}
                            checked={groupPicks.includes(s.id)}
                            disabled={!!s.expense_group_id || !s.payment_type_id || (groupPickTypeId != null && s.payment_type_id !== groupPickTypeId)}
                            onChange={() => toggleGroupPick(s.id)}
                            title={s.expense_group_id ? 'Уже в группе — сначала разгруппируйте' : (!s.payment_type_id ? 'Нужен заданный тип оплаты' : '')}
                          />
                        )}
                        <div style={{ flex: 1 }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                            <span style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</span>
                            <span className={`badge ${s.status === 'активен' ? 'badge-active' : 'badge-pause'}`}>{s.status}</span>
                            {s.payment_types?.name && <span className="badge badge-test">{s.payment_types.name}</span>}
                            {s.expense_group_id && <span className="badge badge-control">🔗 объединено для расхода</span>}
                          </div>
                          <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap' }}>
                            {s.roistat_marker && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>🏷 <code style={{ background: 'var(--bg)', padding: '1px 4px', borderRadius: 3 }}>{s.roistat_marker}</code></span>}
                            {s.calltracking_phone && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>📞 {s.calltracking_phone}</span>}
                            {s.landing_url && <a href={s.landing_url} target="_blank" rel="noreferrer" style={{ fontSize: 11, color: 'var(--green-primary)' }}>🔗 ссылка ↗</a>}
                            {s.cpl_rate && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>CPL: {formatMoney(s.cpl_rate)}</span>}
                            {s.retainer && <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>Або: {formatMoney(s.retainer)}</span>}
                          </div>
                        </div>
                        {isAdmin && s.expense_group_id && (
                          <button className="btn btn-ghost btn-sm" onClick={() => ungroupSources(s.expense_group_id)}>Разгруппировать</button>
                        )}
                        {isAdmin && (
                          <>
                            <button className="btn btn-ghost btn-sm" onClick={() => setEditingSource({ ...s, payment_type_id: s.payment_type_id || '' })}>✏️</button>
                            <button className="btn btn-ghost btn-sm" onClick={() => startDeleteSource(s)}>🗑</button>
                          </>
                        )}
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
          {isAdmin && (
            <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
              <button className="btn btn-primary btn-sm" onClick={() => setShowDecision(true)}>+ Добавить решение</button>
            </div>
          )}
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

          {isAdmin && (
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
          )}

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

      {isAdmin && showStatus && <ChangeStatusModal contractor={contractor} onClose={() => setShowStatus(false)} onSaved={() => { setShowStatus(false); load() }} />}
      {isAdmin && showDecision && <AddDecisionModal contractorId={contractorId} onClose={() => setShowDecision(false)} onSaved={() => { setShowDecision(false); load() }} />}
      {isAdmin && showDelete && <DeleteContractorModal contractor={contractor} archiveStatusId={archiveStatusId} onClose={() => setShowDelete(false)} onDeleted={onBack} onArchived={() => { setShowDelete(false); load() }} />}
    </div>
  )
}
