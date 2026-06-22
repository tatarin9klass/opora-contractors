import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatDate, formatMoney, cplClass, cpqlClass } from '../lib/helpers.js'
import WeeklyFactModal from '../components/WeeklyFactModal.jsx'

export default function WeeklyPage() {
  const [contractors, setContractors] = useState([])
  const [selected, setSelected] = useState('')
  const [facts, setFacts] = useState([])
  const [loading, setLoading] = useState(false)
  const [showModal, setShowModal] = useState(false)

  useEffect(() => {
    supabase.from('contractors')
      .select('id, name, short_name, contractor_statuses(name, is_active)')
      .order('name')
      .then(({ data }) => setContractors(data || []))
  }, [])

  useEffect(() => {
    if (!selected) { setFacts([]); return }
    setLoading(true)
    supabase.from('weekly_facts')
      .select('*, sources(name)')
      .eq('contractor_id', selected)
      .order('week_start', { ascending: false })
      .limit(12)
      .then(({ data }) => { setFacts(data || []); setLoading(false) })
  }, [selected])

  const active = contractors.filter(c => c.contractor_statuses?.is_active)
  const inactive = contractors.filter(c => !c.contractor_statuses?.is_active)
  const selectedContractor = contractors.find(c => c.id === selected)

  return (
    <div>
      <div className="info-card" style={{ marginBottom: 16 }}>
        <div className="info-card-title">Выберите подрядчика</div>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <select
            className="form-select"
            style={{ maxWidth: 360 }}
            value={selected}
            onChange={e => setSelected(e.target.value)}
          >
            <option value="">— выберите подрядчика —</option>
            {active.length > 0 && (
              <optgroup label="Активные">
                {active.map(c => <option key={c.id} value={c.id}>{c.short_name || c.name}</option>)}
              </optgroup>
            )}
            {inactive.length > 0 && (
              <optgroup label="Неактивные">
                {inactive.map(c => <option key={c.id} value={c.id}>{c.short_name || c.name}</option>)}
              </optgroup>
            )}
          </select>
          {selected && (
            <button className="btn btn-primary" onClick={() => setShowModal(true)}>
              + Добавить неделю
            </button>
          )}
        </div>
      </div>

      {selected && (
        <div className="table-wrap">
          <div className="table-toolbar">
            <span style={{ fontSize: 14, fontWeight: 600 }}>
              {selectedContractor?.name} — последние записи
            </span>
          </div>
          {loading ? (
            <div className="loading">Загрузка...</div>
          ) : facts.length === 0 ? (
            <div className="empty-state">
              <div className="empty-state-icon">📅</div>
              <h3>Нет записей</h3>
              <p>Добавьте первую запись кнопкой выше</p>
            </div>
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
                  <th>Кто внёс</th>
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
                      <td className="td-muted">{f.sources?.name || 'Все'}</td>
                      <td style={{textAlign:'right'}}>{f.leads}</td>
                      <td style={{textAlign:'right'}}>{formatMoney(f.spend)}</td>
                      <td style={{textAlign:'right'}}>
                        <span className={`metric ${cplClass(cpl)}`}>{cpl ? formatMoney(cpl) : '—'}</span>
                      </td>
                      <td style={{textAlign:'right'}}>{f.quals}</td>
                      <td style={{textAlign:'right'}}>
                        <span className={`metric ${cpqlClass(cpql)}`}>{cpql ? formatMoney(cpql) : '—'}</span>
                      </td>
                      <td style={{textAlign:'right'}}>{f.meetings}</td>
                      <td style={{textAlign:'right'}}>{f.deals}</td>
                      <td className="td-muted" style={{fontSize:11}}>{f.entered_by || '—'}</td>
                      <td>
                        <span className={`badge ${
                          f.verify_status === 'проверен' ? 'badge-active' :
                          f.verify_status === 'отклонён' ? 'badge-off' : 'badge-new'
                        }`}>{f.verify_status}</span>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {showModal && selected && (
        <WeeklyFactModal
          contractorId={selected}
          contractorName={selectedContractor?.short_name || selectedContractor?.name}
          onClose={() => setShowModal(false)}
          onSaved={() => {
            setShowModal(false)
            // reload facts
            setLoading(true)
            supabase.from('weekly_facts')
              .select('*, sources(name)')
              .eq('contractor_id', selected)
              .order('week_start', { ascending: false })
              .limit(12)
              .then(({ data }) => { setFacts(data || []); setLoading(false) })
          }}
        />
      )}
    </div>
  )
}
