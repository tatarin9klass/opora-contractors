import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { getStatusClass, cplClass, cpqlClass, cacClass, formatMoney, formatDate, metricCardClass } from '../lib/helpers.js'
import ChangeStatusModal from '../components/ChangeStatusModal.jsx'
import AddDecisionModal from '../components/AddDecisionModal.jsx'
import WeeklyFactModal from '../components/WeeklyFactModal.jsx'

const TABS = ['Обзор', 'Источники', 'Оплата', 'Факт', 'Решения', 'История']

export default function PassportPage({ contractorId, onBack }) {
  const [tab, setTab] = useState('Обзор')
  const [contractor, setContractor] = useState(null)
  const [mtd, setMtd] = useState(null)
  const [sources, setSources] = useState([])
  const [payment, setPayment] = useState(null)
  const [facts, setFacts] = useState([])
  const [decisions, setDecisions] = useState([])
  const [statusHistory, setStatusHistory] = useState([])
  const [loading, setLoading] = useState(true)
  const [showStatus, setShowStatus] = useState(false)
  const [showDecision, setShowDecision] = useState(false)
  const [showFact, setShowFact] = useState(false)
  const [showAddSource, setShowAddSource] = useState(false)
  const [newSource, setNewSource] = useState({ name: '', roistat_marker: '', calltracking_phone: '', landing_url: '' })

  async function load() {
    setLoading(true)
    const [c, m, s, p, f, d, sh] = await Promise.all([
      supabase.from('contractors').select('*, contractor_types(name), contractor_statuses(name, is_active)').eq('id', contractorId).single(),
      supabase.from('contractor_mtd').select('*').eq('contractor_id', contractorId).single(),
      supabase.from('sources').select('*').eq('contractor_id', contractorId).order('created_at'),
      supabase.from('payment_models').select('*, payment_types(name)').eq('contractor_id', contractorId).order('created_at', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('weekly_facts').select('*, sources(name)').eq('contractor_id', contractorId).order('week_start', { ascending: false }).limit(20),
      supabase.from('management_decisions').select('*, decision_types(name)').eq('contractor_id', contractorId).order('decision_date', { ascending: false }),
      supabase.from('status_history').select('*, old:old_status_id(name), new:new_status_id(name), reason:reason_id(name)').eq('contractor_id', contractorId).order('changed_at', { ascending: false }),
    ])
    setContractor(c.data)
    setMtd(m.data)
    setSources(s.data || [])
    setPayment(p.data)
    setFacts(f.data || [])
    setDecisions(d.data || [])
    setStatusHistory(sh.data || [])
    setLoading(false)
  }

  useEffect(() => { load() }, [contractorId])

  async function saveSource() {
    if (!newSource.name) return
    await supabase.from('sources').insert({ ...newSource, contractor_id: contractorId })
    setNewSource({ name: '', roistat_marker: '', calltracking_phone: '', landing_url: '' })
    setShowAddSource(false)
    load()
  }

  if (loading) return <div className="loading">Загрузка паспорта...</div>
  if (!contractor) return <div className="loading">Подрядчик не найден</div>

  const status = contractor.contractor_statuses?.name
  const type = contractor.contractor_types?.name

  // Alerts
  const alerts = []
  if (mtd?.cpl_mtd > 1500) alerts.push({ type: 'danger', text: `CPL ${Math.round(mtd.cpl_mtd).toLocaleString('ru-RU')} ₽ — превышен допустимый порог (1 500 ₽)` })
  else if (mtd?.cpl_mtd > 1200) alerts.push({ type: 'warning', text: `CPL ${Math.round(mtd.cpl_mtd).toLocaleString('ru-RU')} ₽ — в жёлтой зоне` })
  if (mtd?.cpql_mtd > 7500) alerts.push({ type: 'danger', text: `CPQL ${Math.round(mtd.cpql_mtd).toLocaleString('ru-RU')} ₽ — превышен допустимый порог` })
  if (mtd?.spend_mtd > 0 && mtd?.leads_mtd === 0) alerts.push({ type: 'danger', text: 'Есть расход, но нет лидов — аномалия' })

  return (
    <div>
      <button className="back-btn" onClick={onBack}>← Все подрядчики</button>

      <div className="passport-header">
        <div style={{ flex: 1 }}>
          <div className="passport-name">{contractor.name}</div>
          <div className="passport-meta">
            <span className={`badge ${getStatusClass(status)}`}>{status}</span>
            {type && <span className="td-muted" style={{ fontSize: 12 }}>{type}</span>}
            {contractor.responsible_name && <span className="td-muted" style={{ fontSize: 12 }}>👤 {contractor.responsible_name}</span>}
          </div>
          {contractor.comment && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8, maxWidth: 600 }}>{contractor.comment}</div>
          )}
        </div>
        <div className="passport-actions">
          <button className="btn btn-secondary btn-sm" onClick={() => setShowFact(true)}>+ Факт</button>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowDecision(true)}>+ Решение</button>
          <button className="btn btn-secondary btn-sm" onClick={() => setShowStatus(true)}>Статус →</button>
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

      {tab === 'Обзор' && (
        <div>
          <div className="metric-grid" style={{ marginBottom: 16 }}>
            <div className={`metric-card ${mtd?.leads_mtd > 0 ? 'neutral' : ''}`}>
              <div className="metric-card-label">Лиды МТД</div>
              <div className="metric-card-value" style={{ color: 'var(--text)' }}>{mtd?.leads_mtd || 0}</div>
            </div>
            <div className={`metric-card ${mtd?.spend_mtd > 0 ? 'neutral' : ''}`}>
              <div className="metric-card-label">Расход МТД</div>
              <div className="metric-card-value" style={{ color: 'var(--text)', fontSize: 16 }}>{formatMoney(mtd?.spend_mtd)}</div>
            </div>
            <div className={`metric-card ${metricCardClass('cpl', mtd?.cpl_mtd)}`}>
              <div className="metric-card-label">CPL</div>
              <div className="metric-card-value" style={{ fontSize: 16 }}>{mtd?.cpl_mtd ? formatMoney(mtd.cpl_mtd) : '—'}</div>
              <div className="metric-card-sub">порог 1 500 ₽</div>
            </div>
            <div className={`metric-card ${metricCardClass('cpql', mtd?.cpql_mtd)}`}>
              <div className="metric-card-label">CPQL</div>
              <div className="metric-card-value" style={{ fontSize: 16 }}>{mtd?.cpql_mtd ? formatMoney(mtd.cpql_mtd) : '—'}</div>
              <div className="metric-card-sub">порог 7 500 ₽</div>
            </div>
            <div className={`metric-card ${metricCardClass('cac', mtd?.cac_mtd)}`}>
              <div className="metric-card-label">CAC накопит.</div>
              <div className="metric-card-value" style={{ fontSize: 14 }}>{mtd?.cac_mtd ? formatMoney(mtd.cac_mtd) : '—'}</div>
              <div className="metric-card-sub">порог 75 000 ₽</div>
            </div>
          </div>

          <div className="info-card">
            <div className="info-card-title">Основная информация</div>
            <div className="info-grid">
              <div className="info-item"><div className="info-item-label">Контакт</div><div className="info-item-value">{contractor.contact_name || '—'}</div></div>
              <div className="info-item"><div className="info-item-label">Telegram</div><div className="info-item-value">{contractor.contact_telegram || '—'}</div></div>
              <div className="info-item"><div className="info-item-label">Телефон</div><div className="info-item-value">{contractor.contact_phone || '—'}</div></div>
              <div className="info-item"><div className="info-item-label">Email</div><div className="info-item-value">{contractor.contact_email || '—'}</div></div>
              <div className="info-item"><div className="info-item-label">Ответственный</div><div className="info-item-value">{contractor.responsible_name || '—'}</div></div>
              <div className="info-item"><div className="info-item-label">Добавлен</div><div className="info-item-value">{formatDate(contractor.created_at)}</div></div>
            </div>
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
                  {decisions[0].next_step && <div className="timeline-body" style={{ marginTop: 4 }}>→ {decisions[0].next_step}</div>}
                </div>
              </div>
            </div>
          )}
        </div>
      )}

      {tab === 'Источники' && (
        <div>
          <div className="info-card">
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
              <div className="info-card-title" style={{ margin: 0 }}>Источники и метки</div>
              <button className="btn btn-secondary btn-sm" onClick={() => setShowAddSource(!showAddSource)}>+ Добавить</button>
            </div>

            {showAddSource && (
              <div style={{ background: 'var(--bg)', border: '1px solid var(--border)', borderRadius: 'var(--radius)', padding: 14, marginBottom: 14 }}>
                <div className="form-row">
                  <div className="form-group"><label className="form-label">Название <span className="req">*</span></label><input className="form-input" value={newSource.name} onChange={e => setNewSource(s => ({ ...s, name: e.target.value }))} /></div>
                  <div className="form-group"><label className="form-label">Roistat marker</label><input className="form-input" value={newSource.roistat_marker} onChange={e => setNewSource(s => ({ ...s, roistat_marker: e.target.value }))} /></div>
                </div>
                <div className="form-row">
                  <div className="form-group"><label className="form-label">Телефон КТ</label><input className="form-input" value={newSource.calltracking_phone} onChange={e => setNewSource(s => ({ ...s, calltracking_phone: e.target.value }))} /></div>
                  <div className="form-group"><label className="form-label">Посадочная</label><input className="form-input" value={newSource.landing_url} onChange={e => setNewSource(s => ({ ...s, landing_url: e.target.value }))} /></div>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-primary btn-sm" onClick={saveSource}>Сохранить</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setShowAddSource(false)}>Отмена</button>
                </div>
              </div>
            )}

            {sources.length === 0 ? (
              <div className="empty-state" style={{ padding: 24 }}>
                <div className="empty-state-icon">📡</div>
                <h3>Источники не добавлены</h3>
              </div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Название</th>
                    <th>Roistat marker</th>
                    <th>Телефон КТ</th>
                    <th>Посадочная</th>
                    <th>Статус</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map(s => (
                    <tr key={s.id}>
                      <td style={{ fontWeight: 500 }}>{s.name}</td>
                      <td className="td-mono">{s.roistat_marker || '—'}</td>
                      <td>{s.calltracking_phone || '—'}</td>
                      <td>{s.landing_url ? <a href={s.landing_url} target="_blank" rel="noreferrer" style={{ color: 'var(--green-primary)', fontSize: 12 }}>ссылка ↗</a> : '—'}</td>
                      <td><span className={`badge ${s.status === 'активен' ? 'badge-active' : 'badge-pause'}`}>{s.status}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {tab === 'Оплата' && (
        <div className="info-card">
          <div className="info-card-title">Модель оплаты</div>
          {!payment ? (
            <div className="empty-state" style={{ padding: 24 }}>
              <div className="empty-state-icon">💳</div>
              <h3>Модель оплаты не заполнена</h3>
            </div>
          ) : (
            <div className="info-grid">
              <div className="info-item"><div className="info-item-label">Тип оплаты</div><div className="info-item-value">{payment.payment_types?.name || '—'}</div></div>
              <div className="info-item"><div className="info-item-label">Ставка CPL</div><div className="info-item-value">{formatMoney(payment.cpl_rate)}</div></div>
              <div className="info-item"><div className="info-item-label">Абонентка</div><div className="info-item-value">{formatMoney(payment.retainer)}</div></div>
              <div className="info-item"><div className="info-item-label">Рекл. бюджет</div><div className="info-item-value">{formatMoney(payment.ad_budget)}</div></div>
              <div className="info-item"><div className="info-item-label">Предоплата</div><div className="info-item-value">{payment.has_prepayment ? 'Да' : 'Нет'}</div></div>
              <div className="info-item"><div className="info-item-label">Остаток баланса</div><div className="info-item-value">{formatMoney(payment.balance)}</div></div>
              {payment.comment && <div className="info-item" style={{ gridColumn: '1/-1' }}><div className="info-item-label">Комментарий</div><div className="info-item-value">{payment.comment}</div></div>}
            </div>
          )}
        </div>
      )}

      {tab === 'Факт' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button className="btn btn-primary btn-sm" onClick={() => setShowFact(true)}>+ Добавить неделю</button>
          </div>
          <div className="table-wrap">
            {facts.length === 0 ? (
              <div className="empty-state"><div className="empty-state-icon">📅</div><h3>Нет данных</h3><p>Добавьте первую запись</p></div>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Неделя</th>
                    <th>Источник</th>
                    <th style={{textAlign:'right'}}>Лиды</th>
                    <th style={{textAlign:'right'}}>Расход</th>
                    <th style={{textAlign:'right'}}>CPL</th>
                    <th style={{textAlign:'right'}}>Квалы</th>
                    <th style={{textAlign:'right'}}>CPQL</th>
                    <th style={{textAlign:'right'}}>Встречи</th>
                    <th style={{textAlign:'right'}}>Сделки</th>
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
                        <td style={{textAlign:'right'}}>{f.leads}</td>
                        <td style={{textAlign:'right'}}>{formatMoney(f.spend)}</td>
                        <td style={{textAlign:'right'}}><span className={`metric ${cplClass(cpl)}`}>{cpl ? formatMoney(cpl) : '—'}</span></td>
                        <td style={{textAlign:'right'}}>{f.quals}</td>
                        <td style={{textAlign:'right'}}><span className={`metric ${cpqlClass(cpql)}`}>{cpql ? formatMoney(cpql) : '—'}</span></td>
                        <td style={{textAlign:'right'}}>{f.meetings}</td>
                        <td style={{textAlign:'right'}}>{f.deals}</td>
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
                    <div className="timeline-title">
                      {h.old?.name || '—'} → {h.new?.name || '—'}
                    </div>
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

      {showStatus && (
        <ChangeStatusModal
          contractor={contractor}
          onClose={() => setShowStatus(false)}
          onSaved={() => { setShowStatus(false); load() }}
        />
      )}
      {showDecision && (
        <AddDecisionModal
          contractorId={contractorId}
          onClose={() => setShowDecision(false)}
          onSaved={() => { setShowDecision(false); load() }}
        />
      )}
      {showFact && (
        <WeeklyFactModal
          contractorId={contractorId}
          contractorName={contractor.short_name || contractor.name}
          onClose={() => setShowFact(false)}
          onSaved={() => { setShowFact(false); load() }}
        />
      )}
    </div>
  )
}
