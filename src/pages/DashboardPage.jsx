import React, { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatMoney, formatDate, getStatusClass } from '../lib/helpers.js'

export default function DashboardPage({ onOpenPassport }) {
  const [data, setData] = useState([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    supabase.from('contractor_mtd').select('*').then(({ data }) => {
      setData(data || [])
      setLoading(false)
    })
  }, [])

  if (loading) return <div className="loading">Загрузка...</div>

  const active = data.filter(d => d.is_active)
  const totalSpend = active.reduce((s, d) => s + (d.spend_mtd || 0), 0)
  const totalLeads = active.reduce((s, d) => s + (d.leads_mtd || 0), 0)
  const totalQuals = active.reduce((s, d) => s + (d.quals_mtd || 0), 0)
  const totalDeals = active.reduce((s, d) => s + (d.deals_mtd || 0), 0)
  const avgCpl = totalLeads > 0 ? Math.round(totalSpend / totalLeads) : null
  const avgCpql = totalQuals > 0 ? Math.round(totalSpend / totalQuals) : null

  const alerts = data.filter(d => d.is_active && (d.cpl_mtd > 1500 || (d.spend_mtd > 0 && d.leads_mtd === 0)))
  const noData = data.filter(d => d.is_active && d.spend_mtd === 0 && d.leads_mtd === 0)

  return (
    <div>
      <div className="kpi-row">
        <div className="kpi-card green">
          <div className="kpi-label">Расход МТД (активные)</div>
          <div className="kpi-value" style={{ fontSize: 22 }}>{formatMoney(totalSpend)}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Лиды МТД</div>
          <div className="kpi-value">{totalLeads}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">CPL средний</div>
          <div className="kpi-value" style={{ fontSize: 20 }}>{avgCpl ? formatMoney(avgCpl) : '—'}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Квалы МТД</div>
          <div className="kpi-value">{totalQuals}</div>
        </div>
        <div className="kpi-card">
          <div className="kpi-label">Сделки МТД</div>
          <div className="kpi-value">{totalDeals}</div>
        </div>
      </div>

      {alerts.length > 0 && (
        <div className="info-card" style={{ borderLeft: '3px solid var(--red)' }}>
          <div className="info-card-title" style={{ color: 'var(--red)' }}>🔴 Требуют внимания</div>
          <div className="timeline">
            {alerts.map(d => (
              <div key={d.contractor_id} className="timeline-item" style={{ cursor: 'pointer' }} onClick={() => onOpenPassport(d.contractor_id)}>
                <div className="timeline-icon">⚠️</div>
                <div className="timeline-content">
                  <div className="timeline-title">{d.short_name || d.name}</div>
                  <div className="timeline-body">
                    {d.cpl_mtd > 1500 && `CPL ${Math.round(d.cpl_mtd).toLocaleString('ru-RU')} ₽ — превышен порог. `}
                    {d.spend_mtd > 0 && d.leads_mtd === 0 && 'Расход есть, лидов нет.'}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {noData.length > 0 && (
        <div className="info-card" style={{ borderLeft: '3px solid var(--yellow)' }}>
          <div className="info-card-title" style={{ color: 'var(--yellow)' }}>⚠️ Нет данных за текущий месяц</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {noData.map(d => (
              <span key={d.contractor_id} className="source-tag" style={{ cursor: 'pointer' }} onClick={() => onOpenPassport(d.contractor_id)}>
                {d.short_name || d.name}
              </span>
            ))}
          </div>
        </div>
      )}

      <div className="info-card">
        <div className="info-card-title">Активные подрядчики — текущий месяц</div>
        <table>
          <thead>
            <tr>
              <th>Подрядчик</th>
              <th>Статус</th>
              <th style={{textAlign:'right'}}>Лиды</th>
              <th style={{textAlign:'right'}}>Расход</th>
              <th style={{textAlign:'right'}}>CPL</th>
              <th style={{textAlign:'right'}}>Квалы</th>
              <th style={{textAlign:'right'}}>Сделки</th>
            </tr>
          </thead>
          <tbody>
            {active.length === 0 ? (
              <tr><td colSpan={7} style={{ textAlign: 'center', padding: 24, color: 'var(--text-muted)' }}>Нет активных подрядчиков</td></tr>
            ) : active.map(d => (
              <tr key={d.contractor_id} style={{ cursor: 'pointer' }} onClick={() => onOpenPassport(d.contractor_id)}>
                <td className="td-name">{d.short_name || d.name}</td>
                <td><span className={`badge ${getStatusClass(d.status)}`}>{d.status}</span></td>
                <td style={{textAlign:'right'}}>{d.leads_mtd || 0}</td>
                <td style={{textAlign:'right'}}>{formatMoney(d.spend_mtd)}</td>
                <td style={{textAlign:'right'}} className={`metric ${d.cpl_mtd > 1500 ? 'metric-danger' : d.cpl_mtd > 1200 ? 'metric-warn' : 'metric-ok'}`}>
                  {d.cpl_mtd ? formatMoney(d.cpl_mtd) : '—'}
                </td>
                <td style={{textAlign:'right'}}>{d.quals_mtd || 0}</td>
                <td style={{textAlign:'right'}}>{d.deals_mtd || 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
