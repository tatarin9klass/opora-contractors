import React, { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatMoney, formatNum, formatDate } from '../lib/helpers.js'
import { loadAvtpData, availableMonths, aggregateChannels, aggregateSources, monthKeyOf, monthLabel } from '../lib/avtpravo.js'

const TABS = ['Источники', 'Файлы']

export default function ChannelPassportPage({ channelId, onBack, isAdmin }) {
  const [data, setData] = useState(null)
  const [files, setFiles] = useState([])
  const [month, setMonth] = useState(monthKeyOf())
  const [tab, setTab] = useState('Источники')
  const [loading, setLoading] = useState(true)

  const [selectedFile, setSelectedFile] = useState(null)
  const [uploadFileType, setUploadFileType] = useState('Договор')
  const [uploadedByName, setUploadedByName] = useState('')
  const [uploading, setUploading] = useState(false)

  async function loadFiles() {
    const { data: rows } = await supabase
      .from('ap_channel_files').select('*').eq('channel_id', channelId).order('uploaded_at', { ascending: false })
    setFiles(rows || [])
  }

  useEffect(() => {
    setLoading(true)
    Promise.all([loadAvtpData(), loadFiles()]).then(([d]) => {
      setData(d)
      const months = availableMonths(d)
      if (months.length && !months.includes(monthKeyOf())) setMonth(months[0])
      setLoading(false)
    })
  }, [channelId])

  const months = useMemo(() => {
    if (!data) return []
    const list = availableMonths(data)
    const cur = monthKeyOf()
    return list.includes(cur) ? list : [cur, ...list]
  }, [data])

  const channel = data?.channels.find(c => c.id === channelId) || null
  const summary = useMemo(() => {
    if (!data) return null
    return aggregateChannels(data, month).find(r => r.channelId === channelId) || null
  }, [data, month, channelId])
  const sourceRows = useMemo(() => (data ? aggregateSources(data, channelId, month) : []), [data, channelId, month])

  // Ключ объекта в Storage должен быть ASCII-safe (кириллица и пробелы дают
  // "Invalid key") — как и для файлов подрядчиков БФЛ. Оригинальное имя файла
  // храним отдельно, только для отображения.
  async function uploadFile() {
    if (!selectedFile || !uploadedByName) {
      alert('Выберите файл и укажите, кто загружает')
      return
    }
    setUploading(true)
    const extMatch = selectedFile.name.match(/\.[^.]+$/)
    const ext = extMatch ? extMatch[0].replace(/[^a-zA-Z0-9.]/g, '') : ''
    const safeId = (crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`)
    const path = `ap/${channelId}/${safeId}${ext}`
    const { error: uploadError } = await supabase.storage.from('contractor-files').upload(path, selectedFile)
    if (uploadError) { alert('Ошибка загрузки: ' + uploadError.message); setUploading(false); return }

    const { data: pub } = supabase.storage.from('contractor-files').getPublicUrl(path)
    const { error } = await supabase.from('ap_channel_files').insert({
      channel_id: channelId,
      file_name: selectedFile.name,
      file_url: pub.publicUrl,
      file_type: uploadFileType,
      uploaded_by: uploadedByName,
    })
    setUploading(false)
    if (error) { alert('Ошибка: ' + error.message); return }
    setSelectedFile(null)
    loadFiles()
  }

  if (loading) return <div className="loading">Загрузка канала...</div>
  if (!channel) return <div className="loading">Канал не найден</div>

  const tiles = [
    { label: 'Расход', val: formatMoney(summary?.spend || 0) },
    { label: 'Лиды', val: formatNum(summary?.leads || 0) },
    { label: 'Договоры', val: formatNum(summary?.contracts || 0) },
    { label: 'CPO', val: summary?.cpo == null ? '—' : formatMoney(summary.cpo) },
  ]

  return (
    <div>
      <button className="back-btn" onClick={onBack}>← Все каналы</button>

      <div className="passport-header">
        <div style={{ flex: 1 }}>
          <div className="passport-name">{channel.name}</div>
          <div className="passport-meta">
            <span className="badge badge-test">{channel.direction === 'avrkm' ? 'АВАРКОМ' : 'АВТОПРАВО'}</span>
            <span className="td-muted" style={{ fontSize: 12 }}>источников: {sourceRows.length}</span>
          </div>
        </div>
        <div style={{ width: 260 }}>
          <select className="form-select" style={{ width: '100%' }} value={month} onChange={e => setMonth(e.target.value)}>
            {months.map(m => <option key={m} value={m}>{monthLabel(m)}</option>)}
          </select>
        </div>
      </div>

      <div className="info-card">
        <div className="info-card-title">Показатели канала — {monthLabel(month)}</div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
          {tiles.map(item => (
            <div key={item.label} style={{ background: 'var(--bg)', borderRadius: 'var(--radius)', padding: '10px 12px' }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase' }}>{item.label}</div>
              <div style={{ fontSize: 16, fontWeight: 700, marginTop: 2 }}>{item.val}</div>
            </div>
          ))}
        </div>
      </div>

      <div className="tabs">
        {TABS.map(t => (
          <button key={t} className={`tab ${tab === t ? 'active' : ''}`} onClick={() => setTab(t)}>{t}</button>
        ))}
      </div>

      {tab === 'Источники' && (
        <div className="info-card">
          <div className="info-card-title">Источники канала — {monthLabel(month)}</div>
          <div style={{ fontSize: 12, color: 'var(--text-muted)', marginBottom: 12 }}>
            Расход вводится на канал целиком, поэтому по источникам показаны только количественные показатели.
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table className="table-compact">
              <thead>
                <tr>
                  <th>Источник</th>
                  <th style={{ textAlign: 'right' }}>Лиды</th>
                  <th style={{ textAlign: 'right' }}>Договоры</th>
                </tr>
              </thead>
              <tbody>
                {sourceRows.length === 0 ? (
                  <tr><td colSpan={3} className="td-muted" style={{ textAlign: 'center', padding: 12 }}>К этому каналу не привязано ни одного источника</td></tr>
                ) : sourceRows.map(row => (
                  <tr key={row.id}>
                    <td>{row.name}</td>
                    <td style={{ textAlign: 'right' }}>{formatNum(row.leads)}</td>
                    <td style={{ textAlign: 'right' }}>{formatNum(row.contracts)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {tab === 'Файлы' && (
        <div className="info-card">
          <div className="info-card-title">Документы канала</div>

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
    </div>
  )
}
