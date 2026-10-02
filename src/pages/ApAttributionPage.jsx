import React, { useEffect, useMemo, useState } from 'react'
import { supabase, fetchAllRows } from '../lib/supabase.js'
import { formatNum } from '../lib/helpers.js'

// ============================================================================
// Разовая сверка источников по выигранным сделкам Автоправо.
//
// Экран намеренно сделан отдельным, а не блоком внутри «Каналов»: это слепок
// ручного разбора выгрузки, а не живая витрина. Он не меняет ни одной цифры в
// остальном приложении — ни в каналах, ни в CPO, — а только показывает, чем
// сделки являются на самом деле. Битрикс при этом не трогается: при следующем
// импорте ap_deals перезапишется, а сверка останется прежней.
// ============================================================================

const KIND_COLORS = {
  'рекомендация': '#3A7E34',
  'перевод из БФЛ': '#b06a00',
  'повторное обращение': '#2c6e8f',
  'подмена источника': '#a33',
  'перевод из Аваркома': '#7a5aa8',
  'источник не определён': '#8a8a8a',
  'разовый обзвон базы': '#8a8a8a',
}

function Badge({ kind }) {
  return (
    <span style={{
      display: 'inline-block', padding: '1px 7px', borderRadius: 10, fontSize: 11,
      color: '#fff', background: KIND_COLORS[kind] || '#777', whiteSpace: 'nowrap',
    }}>{kind}</span>
  )
}

export default function ApAttributionPage() {
  const [totals, setTotals] = useState([])
  const [recs, setRecs] = useState([])
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [showAll, setShowAll] = useState(false)

  useEffect(() => {
    Promise.all([
      fetchAllRows(() => supabase.from('ap_attribution_totals').select('*')),
      fetchAllRows(() => supabase.from('ap_recommenders').select('*')),
      fetchAllRows(() => supabase.from('ap_attribution_rows').select('*')),
    ])
      .then(([t, r, rw]) => { setTotals(t); setRecs(r); setRows(rw) })
      .catch(e => setError(String(e?.message || e)))
      .finally(() => setLoading(false))
  }, [])

  const changed = useMemo(
    () => rows.filter(r => r.сейчас_в_приложении !== r.на_самом_деле),
    [rows],
  )
  const byKind = useMemo(() => {
    const m = new Map()
    for (const r of rows) m.set(r.тип, (m.get(r.тип) || 0) + 1)
    return [...m.entries()].sort((a, b) => b[1] - a[1])
  }, [rows])

  if (loading) return <div className="card">Загрузка сверки…</div>
  if (error) return <div className="card" style={{ color: '#a33' }}>Ошибка: {error}</div>
  if (!rows.length) {
    return (
      <div className="card">
        Сверка пуста — не применена миграция <code>20261005_ap_attribution_override.sql</code>.
      </div>
    )
  }

  const visible = showAll ? rows : changed

  return (
    <div style={{ display: 'grid', gap: 16 }}>
      <div className="card">
        <h3 style={{ marginTop: 0 }}>Разовая сверка источников</h3>
        <p style={{ color: '#666', margin: '0 0 12px' }}>
          Ручной разбор {formatNum(rows.length)} выигранных сделок за январь — сентябрь 2026.
          Экран ничего не меняет в остальном приложении: каналы, расходы и CPO считаются
          по-прежнему из Битрикса. Здесь видно только то, чем сделки являются на самом деле.
        </p>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {byKind.map(([k, n]) => (
            <div key={k} style={{
              border: '1px solid #e3e8e2', borderRadius: 8, padding: '8px 12px', minWidth: 120,
            }}>
              <div style={{ fontSize: 22, fontWeight: 700 }}>{n}</div>
              <div style={{ marginTop: 2 }}><Badge kind={k} /></div>
            </div>
          ))}
        </div>
        <p style={{ color: '#666', marginBottom: 0, marginTop: 12 }}>
          Атрибуция расходится у <b>{changed.length}</b> сделок из {rows.length}.
        </p>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Было → стало по источникам</h3>
        <table className="table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Источник</th>
              <th style={{ textAlign: 'right' }}>Сейчас в приложении</th>
              <th style={{ textAlign: 'right' }}>На самом деле</th>
              <th style={{ textAlign: 'right' }}>Разница</th>
            </tr>
          </thead>
          <tbody>
            {[...totals].sort((a, b) => Math.abs(b.разница) - Math.abs(a.разница)).map(t => (
              <tr key={t.источник}>
                <td>{t.источник}</td>
                <td style={{ textAlign: 'right' }}>{t.сейчас_сделок || '—'}</td>
                <td style={{ textAlign: 'right' }}>{t.должно_быть || '—'}</td>
                <td style={{
                  textAlign: 'right', fontWeight: 600,
                  color: t.разница > 0 ? '#3A7E34' : t.разница < 0 ? '#a33' : '#999',
                }}>
                  {t.разница > 0 ? `+${t.разница}` : t.разница || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <h3 style={{ marginTop: 0 }}>Рекомендации по рекомендателям</h3>
        <p style={{ color: '#666', margin: '0 0 10px' }}>
          Постоянные клиенты и сотрудники, которые регулярно приводят знакомых.
          В Битриксе все они лежат одним источником «Рекомендация».
        </p>
        <table className="table">
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>Рекомендатель</th>
              <th style={{ textAlign: 'right' }}>Сделок</th>
              <th style={{ textAlign: 'right' }}>Доля</th>
              <th style={{ textAlign: 'right' }}>Период</th>
            </tr>
          </thead>
          <tbody>
            {[...recs].sort((a, b) => b.сделок - a.сделок).map(r => (
              <tr key={r.рекомендатель}>
                <td>{r.рекомендатель}</td>
                <td style={{ textAlign: 'right', fontWeight: 600 }}>{r.сделок}</td>
                <td style={{ textAlign: 'right' }}>{r.доля_рекомендаций}%</td>
                <td style={{ textAlign: 'right', color: '#777', fontSize: 12 }}>
                  {r.первая_сделка || '—'} … {r.последняя_сделка || '—'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="card">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <h3 style={{ margin: 0 }}>
            Построчно {showAll ? `(все ${rows.length})` : `(только расхождения: ${changed.length})`}
          </h3>
          <button className="btn" onClick={() => setShowAll(v => !v)}>
            {showAll ? 'Только расхождения' : 'Показать все'}
          </button>
        </div>
        <table className="table" style={{ marginTop: 10 }}>
          <thead>
            <tr>
              <th style={{ textAlign: 'left' }}>ID</th>
              <th style={{ textAlign: 'left' }}>Дата</th>
              <th style={{ textAlign: 'left' }}>Сейчас</th>
              <th style={{ textAlign: 'left' }}>На самом деле</th>
              <th style={{ textAlign: 'left' }}>Рекомендатель</th>
              <th style={{ textAlign: 'left' }}>Тип</th>
            </tr>
          </thead>
          <tbody>
            {[...visible].sort((a, b) => String(b.дата || '').localeCompare(String(a.дата || ''))).map(r => (
              <tr key={r.deal_id} title={r.исходный_текст || ''}>
                <td>{r.deal_id}</td>
                <td style={{ whiteSpace: 'nowrap' }}>{r.дата || '—'}</td>
                <td style={{ color: '#777' }}>{r.сейчас_в_приложении}</td>
                <td style={{ fontWeight: 600 }}>{r.на_самом_деле}</td>
                <td>{r.рекомендатель || '—'}</td>
                <td><Badge kind={r.тип} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <p style={{ color: '#888', fontSize: 12, marginBottom: 0 }}>
          Наведите курсор на строку — покажется исходный текст поля «Дополнительно об источнике».
        </p>
      </div>
    </div>
  )
}
