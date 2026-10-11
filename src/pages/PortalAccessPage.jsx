import React, { useEffect, useState } from 'react'
import { supabase, fetchAllRows } from '../lib/supabase.js'
import { formatMoscow } from '../lib/portal.js'

// ============================================================================
// Доступы подрядчиков: что открыто, что мешает открыть, и памятка, которую
// подрядчик увидит.
//
// ЗАЧЕМ ЭКРАН, А НЕ ПАРА ЗАПРОСОВ В SQL. Перед выдачей доступа надо проверить
// три вещи, и каждая из них — утечка или спор, если не проверить:
//   * нет вьюх и таблиц с открытыми правами (portal_security_audit);
//   * ни один маркер не записан на двух подрядчиков (portal_source_conflicts) —
//     иначе чужие заявки попали бы в чужой кабинет;
//   * все стадии воронки описаны (portal_stage_guide_gaps) — иначе подрядчик
//     увидит стадию без объяснения и позвонит спрашивать.
// Через месяц никто не вспомнит, что это надо проверять, поэтому проверка
// лежит на экране, а не в чьей-то памяти.
//
// ВЫДАЧА ПАРОЛЯ. Кнопка «Выдать пароль» просит Edge Function portal-access
// сгенерировать пароль и задать его подрядчику служебным ключом. Ключ лежит
// на сервере и в браузер не попадает — иначе он отдал бы всю базу целиком,
// потому что обходит все запреты доступа. Функция перед выдачей проверяет, что
// её вызвал admin, по его собственному токену.
//
// ПАРОЛЬ ПОКАЗЫВАЕТСЯ ОДИН РАЗ И НИГДЕ НЕ ХРАНИТСЯ. Потерялся — выдать новый,
// это одна кнопка. Хранить его в базе значило бы отправлять пароли в каждую
// резервную копию и в каждую выгрузку, не получая ничего взамен. В журнале
// остаётся только факт выдачи: кто, кому, когда и до какого числа.
// ============================================================================

const ISSUE_URL = 'https://jgmuuehxavwlrfkonnzx.supabase.co/functions/v1/portal-access'

const STATE_COLOR = {
  'действует': 'var(--green-dark)',
  'истекает — пора выдать': 'var(--yellow)',
  'просрочен — выдать новый': 'var(--red)',
  'пароль не выдавали': 'var(--text-muted)',
  'доступ приостановлен': 'var(--red)',
}

function Block({ title, hint, children }) {
  return (
    <div className="info-card" style={{ marginBottom: 16 }}>
      <div className="info-card-title">{title}</div>
      {hint && <p style={{ fontSize: 12, color: 'var(--text-muted)', margin: '4px 0 10px', lineHeight: 1.55 }}>{hint}</p>}
      {children}
    </div>
  )
}

function Ok({ text }) {
  return <div className="alert alert-info" style={{ marginTop: 4 }}>✅ {text}</div>
}

export default function PortalAccessPage() {
  const [access, setAccess] = useState([])
  const [conflicts, setConflicts] = useState([])
  const [gaps, setGaps] = useState([])
  const [audit, setAudit] = useState([])
  const [guide, setGuide] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [issuingFor, setIssuingFor] = useState(null)
  const [issued, setIssued] = useState(null)
  const [copied, setCopied] = useState(false)

  // silent — обновление после выдачи пароля: показывать «Загрузка...» на весь
  // экран нельзя, иначе только что выданный пароль мигнёт и исчезнет.
  async function load(silent = false) {
    if (!silent) setLoading(true)
    setError('')
    try {
      const [a, c, g, au, sg] = await Promise.all([
        fetchAllRows(() => supabase.from('contractor_access_status').select('*')),
        fetchAllRows(() => supabase.from('portal_source_conflicts').select('*')),
        fetchAllRows(() => supabase.from('portal_stage_guide_gaps').select('*')),
        fetchAllRows(() => supabase.from('portal_security_audit').select('*')),
        fetchAllRows(() => supabase.from('bfl_lead_stage_guide').select('*').order('sort_order')),
      ])
      setAccess(a); setConflicts(c); setGaps(g); setAudit(au); setGuide(sg)
    } catch (e) {
      setError(String(e?.message || e))
    } finally {
      if (!silent) setLoading(false)
    }
  }

  useEffect(() => { load() }, [])

  // Выдача пароля. Токен берётся из текущей сессии и уходит в функцию — она по
  // нему и проверяет, что выдаёт именно админ. Анонимного ключа здесь
  // недостаточно: по нему не видно, кто пришёл.
  async function issuePassword(row) {
    setIssuingFor(row.profile_id)
    setError('')
    setIssued(null)
    setCopied(false)
    try {
      const { data: { session } } = await supabase.auth.getSession()
      if (!session) throw new Error('Сессия истекла — войдите заново')

      const res = await fetch(ISSUE_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${session.access_token}`,
        },
        body: JSON.stringify({ profile_id: row.profile_id }),
      })
      const json = await res.json().catch(() => null)
      if (!json?.success) {
        // Пароль может вернуться даже при ошибке — если он уже задан, а срок
        // записать не удалось. Тогда его важно показать, а не потерять.
        if (json?.password) setIssued({ ...json, email: row.email })
        throw new Error(json?.error || `HTTP ${res.status}`)
      }
      setIssued({ ...json, email: row.email })
      await load(true)
    } catch (e) {
      setError(String(e?.message || e))
    } finally {
      setIssuingFor(null)
    }
  }

  async function copy(text) {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(true)
    } catch {
      // Буфер обмена недоступен (старый браузер, доступ без https) — пароль
      // и так виден на экране, выделяется одним щелчком.
      setCopied(false)
    }
  }

  async function saveDescription(statusName) {
    setSaving(true)
    const { error: e } = await supabase
      .from('bfl_lead_stage_guide')
      .update({ description: draft })
      .eq('status_name', statusName)
    setSaving(false)
    if (e) { setError(e.message); return }
    setGuide(prev => prev.map(g => (g.status_name === statusName ? { ...g, description: draft } : g)))
    setEditing(null)
  }

  if (loading) return <div className="loading">Загрузка...</div>

  return (
    <div>
      {error && <div className="alert alert-danger" style={{ marginBottom: 16 }}>{error}</div>}

      <Block
        title="Проверка прав доступа"
        hint="Пустой результат — всё закрыто правильно. Любая строка означает, что кто-то создал таблицу или вьюху мимо миграций, и она приехала с правами по умолчанию. Смотреть после каждой правки схемы."
      >
        {audit.length === 0 ? <Ok text="Открытых объектов нет." /> : (
          <table>
            <thead>
              <tr><th>Проблема</th><th>Объект</th><th>Что делать</th></tr>
            </thead>
            <tbody>
              {audit.map((r, i) => (
                <tr key={i}>
                  <td style={{ color: 'var(--red)', fontWeight: 600 }}>{r.проблема}</td>
                  <td className="td-mono">{r.объект}</td>
                  <td style={{ fontSize: 12 }}>{r.что_делать}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Block>

      <Block
        title="Маркеры, записанные на двух подрядчиков"
        hint="Пока маркер здесь, его заявки не видны в кабинете НИКОМУ. Так сделано сознательно: пропавшая заявка — это спор, а показанная чужому — утечка. Чистить в справочнике источников."
      >
        {conflicts.length === 0 ? <Ok text="Каждый маркер принадлежит одному подрядчику." /> : (
          <table>
            <thead>
              <tr><th>Маркер</th><th style={{ textAlign: 'right' }}>Подрядчиков</th><th>Кто претендует</th></tr>
            </thead>
            <tbody>
              {conflicts.map(r => (
                <tr key={r.маркер}>
                  <td className="td-mono">{r.маркер}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600, color: 'var(--red)' }}>{r.подрядчиков}</td>
                  <td style={{ fontSize: 12 }}>{r.кто_претендует}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Block>

      <Block
        title="Стадии без описания"
        hint="Стадии, которые встречаются в заявках, но в памятке не описаны. Подрядчик увидит такую стадию без объяснения. Появляются, когда стадию в Битриксе переименовали или добавили новую."
      >
        {gaps.length === 0 ? <Ok text="Все стадии описаны." /> : (
          <table>
            <thead>
              <tr><th>Стадия</th><th style={{ textAlign: 'right' }}>Заявок</th><th>Последняя</th></tr>
            </thead>
            <tbody>
              {gaps.map(r => (
                <tr key={r.стадия_без_описания}>
                  <td style={{ fontWeight: 600 }}>{r.стадия_без_описания}</td>
                  <td style={{ textAlign: 'right' }}>{r.лидов}</td>
                  <td className="td-muted">{r.последний_лид}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Block>

      <div className="table-wrap" style={{ marginBottom: 16 }}>
        <div className="table-toolbar">
          <strong style={{ fontSize: 13 }}>Выданные доступы</strong>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            {access.length ? `подрядчиков с кабинетом: ${access.length}` : 'доступов пока нет'}
          </span>
          <button className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }} onClick={() => load()}>Обновить</button>
        </div>
        {issued && (
          <div style={{
            margin: 16, padding: 16, borderRadius: 'var(--radius)',
            background: 'var(--green-bg)', border: '1px solid var(--green-primary)',
          }}>
            <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
              Пароль для {issued.email} — показывается один раз
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <code style={{
                fontSize: 20, fontWeight: 700, letterSpacing: 1,
                background: 'var(--white)', border: '1px solid var(--border)',
                borderRadius: 'var(--radius)', padding: '8px 14px', userSelect: 'all',
              }}>
                {issued.password}
              </code>
              <button className="btn btn-secondary btn-sm" onClick={() => copy(issued.password)}>
                {copied ? 'Скопировано' : 'Скопировать'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setIssued(null)}>Скрыть</button>
            </div>
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 10, lineHeight: 1.6 }}>
              Действует до <b>{formatMoscow(issued.expires_at)}</b>. Передайте подрядчику
              вместе со ссылкой на приложение. Нигде не сохранён — если потеряется,
              просто выдайте новый.
            </div>
          </div>
        )}

        {access.length === 0 ? (
          <div style={{ padding: 16, fontSize: 13, color: 'var(--text-muted)' }}>
            Ни одного кабинета не заведено. Заводятся они в паспорте подрядчика —
            блок «Доступ в кабинет» внизу страницы. Там же подрядчик известен из самого
            экрана, поэтому привязать доступ не к тому подрядчику невозможно. Этот экран
            показывает всех разом: у кого срок подходит к концу и у кого уже вышел.
          </div>
        ) : (
          <table>
            <thead>
              <tr>
                <th>Подрядчик</th>
                <th>Email</th>
                <th>Состояние</th>
                <th>Пароль выдан</th>
                <th style={{ textAlign: 'right' }}>Осталось</th>
                <th style={{ width: 150 }} />
              </tr>
            </thead>
            <tbody>
              {/* Сортировка приходит из базы: сверху то, с чем надо что-то
                  делать. Иначе на десятке подрядчиков просроченный теряется
                  среди действующих. */}
              {[...access].sort((a, b) => a.приоритет - b.приоритет).map(r => (
                <tr key={r.profile_id}>
                  <td style={{ fontWeight: 600 }}>{r.подрядчик}</td>
                  <td className="td-mono">{r.email}</td>
                  <td style={{ fontSize: 12, color: STATE_COLOR[r.состояние] || 'var(--text-muted)' }}>
                    {r.состояние}
                  </td>
                  <td className="td-muted">{r.выдан ? formatMoscow(r.выдан) : '—'}</td>
                  <td style={{ textAlign: 'right' }}>
                    {r.дней_осталось == null ? '—' : `${r.дней_осталось} дн.`}
                  </td>
                  <td>
                    <button
                      className={`btn btn-sm ${r.приоритет <= 3 ? 'btn-primary' : 'btn-ghost'}`}
                      disabled={issuingFor === r.profile_id}
                      onClick={() => issuePassword(r)}
                    >
                      {issuingFor === r.profile_id
                        ? 'Выдаём...'
                        : r.выдан ? 'Выдать новый' : 'Выдать пароль'}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      <div className="table-wrap" style={{ marginBottom: 16 }}>
        <div className="table-toolbar">
          <strong style={{ fontSize: 13 }}>Памятка по стадиям — то, что видит подрядчик</strong>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
            формулировки можно править здесь, без миграции
          </span>
        </div>
        <table>
          <thead>
            <tr>
              <th style={{ width: 230 }}>Стадия</th>
              <th style={{ width: 60, textAlign: 'center' }}>Квал</th>
              <th>Что означает</th>
              <th style={{ width: 90 }} />
            </tr>
          </thead>
          <tbody>
            {guide.map(g => (
              <tr key={g.status_name}>
                <td style={{ fontWeight: 600 }}>{g.status_name}</td>
                <td style={{ textAlign: 'center' }}>{g.is_qual ? '✅' : ''}</td>
                <td style={{ fontSize: 12, lineHeight: 1.55 }}>
                  {editing === g.status_name ? (
                    <textarea
                      className="form-textarea"
                      value={draft}
                      onChange={e => setDraft(e.target.value)}
                      rows={3}
                      style={{ width: '100%' }}
                    />
                  ) : g.description}
                </td>
                <td>
                  {editing === g.status_name ? (
                    <div style={{ display: 'flex', gap: 6 }}>
                      <button
                        className="btn btn-primary btn-sm" disabled={saving}
                        onClick={() => saveDescription(g.status_name)}
                      >
                        ОК
                      </button>
                      <button className="btn btn-ghost btn-sm" onClick={() => setEditing(null)}>Отмена</button>
                    </div>
                  ) : (
                    <button
                      className="btn btn-ghost btn-sm"
                      onClick={() => { setEditing(g.status_name); setDraft(g.description) }}
                    >
                      Править
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="info-card">
        <div className="info-card-title">Что подрядчик видит и чего не видит</div>
        <div style={{ fontSize: 13, lineHeight: 1.7, marginTop: 6 }}>
          <div><b>Видит:</b> свои заявки с телефоном и UTM, стадию каждой заявки, свои
            квалы, встречи, договоры и дубли по дням и по своим источникам, памятку
            по стадиям.</div>
          <div style={{ marginTop: 6 }}><b>Не видит ни при каких условиях:</b> расход,
            выручку, стоимость лида и квала, свою ставку и абонентку, других подрядчиков,
            менеджеров, направления Автоправо и Аварком.</div>
          <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>
            Это не настройка интерфейса: у роли contractor нет прав ни на одну базовую
            таблицу, а вьюхи кабинета не содержат этих колонок в принципе. Запрос мимо
            приложения вернёт то же самое.
          </div>
          <div style={{ marginTop: 10 }}><b>Пароли:</b> выдаёте вы, кнопкой в таблице выше.
            Пароль действует 31 день, после чего кабинет закрывается сам — подрядчик
            увидит «срок доступа истёк» и придёт за новым. Сам сменить пароль он не
            может: это выданный доступ, а не его личная учётная запись.</div>
          <div style={{ marginTop: 6, color: 'var(--text-muted)' }}>
            Завести кабинет, приостановить его или закрыть насовсем — в паспорте
            подрядчика, блок «Доступ в кабинет».
          </div>
        </div>
      </div>
    </div>
  )
}
