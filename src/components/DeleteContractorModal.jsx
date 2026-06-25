import React, { useState } from 'react'
import { supabase } from '../lib/supabase.js'

export default function DeleteContractorModal({ contractor, archiveStatusId, onClose, onDeleted, onArchived }) {
  const [action, setAction] = useState('archive') // 'archive' | 'delete'
  const [confirm, setConfirm] = useState('')
  const [loading, setLoading] = useState(false)

  const isConfirmed = action === 'archive' || confirm === contractor.short_name

  async function handleSubmit() {
    if (!isConfirmed) return
    setLoading(true)

    if (action === 'archive') {
      await supabase.from('contractors').update({ status_id: archiveStatusId }).eq('id', contractor.id)
      setLoading(false)
      onArchived()
    } else {
      await supabase.from('contractors').delete().eq('id', contractor.id)
      setLoading(false)
      onDeleted()
    }
  }

  return (
    <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal">
        <div className="modal-header">
          <h2>Удаление подрядчика</h2>
          <button className="btn-close" onClick={onClose}>×</button>
        </div>
        <div className="modal-body">
          <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 16 }}>{contractor.name}</div>

          {/* Выбор действия */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginBottom: 20 }}>
            <label style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 14px', border: `2px solid ${action === 'archive' ? 'var(--green-primary)' : 'var(--border)'}`, borderRadius: 'var(--radius)', cursor: 'pointer', background: action === 'archive' ? 'var(--green-bg)' : 'var(--white)' }}>
              <input type="radio" name="action" value="archive" checked={action === 'archive'} onChange={() => { setAction('archive'); setConfirm('') }} style={{ marginTop: 2 }} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 13 }}>📦 Перевести в архив</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Подрядчик скрывается из активных списков, но все данные сохраняются. Можно восстановить.</div>
              </div>
            </label>
            <label style={{ display: 'flex', gap: 12, alignItems: 'flex-start', padding: '12px 14px', border: `2px solid ${action === 'delete' ? 'var(--red)' : 'var(--border)'}`, borderRadius: 'var(--radius)', cursor: 'pointer', background: action === 'delete' ? 'var(--red-bg)' : 'var(--white)' }}>
              <input type="radio" name="action" value="delete" checked={action === 'delete'} onChange={() => setAction('delete')} style={{ marginTop: 2 }} />
              <div>
                <div style={{ fontWeight: 600, fontSize: 13, color: 'var(--red)' }}>🗑 Удалить полностью</div>
                <div style={{ fontSize: 12, color: 'var(--text-muted)', marginTop: 2 }}>Удаляются подрядчик, все источники, расходы, решения и история. Необратимо.</div>
              </div>
            </label>
          </div>

          {/* Подтверждение для удаления */}
          {action === 'delete' && (
            <div className="form-group">
              <label className="form-label">
                Для подтверждения введите название подрядчика: <strong>{contractor.short_name}</strong>
              </label>
              <input
                className="form-input"
                value={confirm}
                onChange={e => setConfirm(e.target.value)}
                placeholder={contractor.short_name}
                style={{ borderColor: confirm && !isConfirmed ? 'var(--red)' : undefined }}
              />
            </div>
          )}
        </div>
        <div className="modal-footer">
          <button className="btn btn-secondary" onClick={onClose}>Отмена</button>
          <button
            className={`btn ${action === 'delete' ? 'btn-danger' : 'btn-primary'}`}
            onClick={handleSubmit}
            disabled={loading || !isConfirmed}
          >
            {loading ? 'Выполняется...' : action === 'archive' ? '📦 В архив' : '🗑 Удалить'}
          </button>
        </div>
      </div>
    </div>
  )
}
