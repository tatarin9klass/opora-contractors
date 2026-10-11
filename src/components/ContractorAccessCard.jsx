import React, { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { formatMoscow } from '../lib/portal.js'

// ============================================================================
// Доступ подрядчика в кабинет — блок в его паспорте.
//
// ЗАЧЕМ В ПАСПОРТЕ. Раньше доступ заводился в три приёма, и два из них шли
// мимо приложения: пользователь в дашборде Supabase, привязка запросом в
// SQL-редакторе, и только третьим шагом кнопка. Самая вероятная ошибка в
// такой последовательности — не опечатка в почте (она видна сразу), а
// привязка к НЕ ТОМУ подрядчику: названия похожи, их полтора десятка, и
// делается это раз в несколько месяцев по памяти. Цена ошибки — подрядчик
// видит чужие заявки.
//
// В паспорте подрядчик известен из самого экрана. Выбирать его не нужно, и
// ошибиться в нём нельзя — это главное, что даёт перенос сюда.
//
// ПАРОЛЬ ПОКАЗЫВАЕТСЯ ОДИН РАЗ. Он нигде не хранится: ни в базе, ни в
// журнале. Потерялся — выдать новый, это одна кнопка. Хранение отправляло бы
// пароли в каждую резервную копию и в любую выгрузку базы, не давая взамен
// ничего.
// ============================================================================

const FUNCTION_URL = 'https://jgmuuehxavwlrfkonnzx.supabase.co/functions/v1/portal-access'

// Тот же алфавит, что и на сервере: без похожих друг на друга знаков. Пароль
// передают в переписке и иногда диктуют, и «это ноль или буква О» — самая
// частая причина, по которой человек потом не может войти.
const ALPHABET = 'abcdefghijkmnpqrstuvwxyzACDEFGHJKLMNPQRSTUVWXYZ23456789'

function generatePassword() {
  const bytes = new Uint8Array(15)
  crypto.getRandomValues(bytes)
  const chars = [...bytes].map(b => ALPHABET[b % ALPHABET.length])
  return [chars.slice(0, 5), chars.slice(5, 10), chars.slice(10, 15)]
    .map(g => g.join('')).join('-')
}

const STATE_COLOR = {
  'действует': 'var(--green-dark)',
  'истекает — пора выдать': 'var(--yellow)',
  'просрочен — выдать новый': 'var(--red)',
  'пароль не выдавали': 'var(--text-muted)',
  'доступ приостановлен': 'var(--red)',
}

export default function ContractorAccessCard({ contractorId, contractorName }) {
  const [row, setRow] = useState(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [issued, setIssued] = useState(null)
  const [copied, setCopied] = useState(false)

  const [creating, setCreating] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [confirmRevoke, setConfirmRevoke] = useState(false)

  async function load(silent = false) {
    if (!silent) setLoading(true)
    const { data, error: e } = await supabase
      .from('contractor_access_status')
      .select('*')
      .eq('contractor_id', contractorId)
      .maybeSingle()
    if (e) setError(e.message)
    setRow(data || null)
    if (!silent) setLoading(false)
  }

  useEffect(() => { load() }, [contractorId])

  // Общий вызов функции. Токен берётся из текущей сессии: функция по нему и
  // проверяет, что пришёл админ. Анонимного ключа тут мало — по нему не
  // видно, кто пришёл.
  async function call(payload) {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session) throw new Error('Сессия истекла — войдите заново')
    const res = await fetch(FUNCTION_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.access_token}`,
      },
      body: JSON.stringify(payload),
    })
    const json = await res.json().catch(() => null)
    if (!json?.success) {
      // Пароль может вернуться и при ошибке — если он уже задан, а срок
      // записать не удалось. Тогда его важно показать, а не потерять.
      if (json?.password) setIssued({ password: json.password, email: json.email || email })
      throw new Error(json?.error || `HTTP ${res.status}`)
    }
    return json
  }

  async function createAccess() {
    setBusy(true); setError(''); setIssued(null); setCopied(false)
    try {
      const json = await call({
        action: 'create',
        contractor_id: contractorId,
        email: email.trim(),
        password: password.trim() || undefined,
      })
      setIssued(json)
      setCreating(false)
      setEmail(''); setPassword('')
      await load(true)
    } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
  }

  async function issuePassword() {
    setBusy(true); setError(''); setIssued(null); setCopied(false)
    try {
      const json = await call({ action: 'issue', profile_id: row.profile_id })
      setIssued(json)
      await load(true)
    } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
  }

  // Приостановка — обычная запись в profiles: право на неё у админа есть, и
  // гонять ради одного булева поля запрос через сервер незачем.
  async function toggleSuspend() {
    setBusy(true); setError('')
    const suspended = row.состояние === 'доступ приостановлен'
    const { error: e } = await supabase
      .from('profiles')
      .update({ must_change_password: !suspended })
      .eq('id', row.profile_id)
    if (e) setError(e.message)
    await load(true)
    setBusy(false)
  }

  async function revoke() {
    setBusy(true); setError('')
    try {
      const json = await call({ action: 'revoke', profile_id: row.profile_id })
      if (json.warning) setError(json.warning)
      setConfirmRevoke(false)
      setIssued(null)
      await load(true)
    } catch (e) { setError(String(e?.message || e)) } finally { setBusy(false) }
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); setCopied(true) } catch { setCopied(false) }
  }

  if (loading) {
    return (
      <div className="info-card">
        <div className="info-card-title">Доступ в кабинет</div>
        <div style={{ fontSize: 13, color: 'var(--text-muted)', marginTop: 8 }}>Загрузка...</div>
      </div>
    )
  }

  return (
    <div className="info-card">
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <div className="info-card-title" style={{ margin: 0 }}>Доступ в кабинет</div>
        {row && (
          <span style={{ fontSize: 12, fontWeight: 600, color: STATE_COLOR[row.состояние] || 'var(--text-muted)' }}>
            {row.состояние}
          </span>
        )}
      </div>

      {error && <div className="alert alert-danger" style={{ marginBottom: 10 }}>{error}</div>}

      {issued && (
        <div style={{
          padding: 14, marginBottom: 12, borderRadius: 'var(--radius)',
          background: 'var(--green-bg)', border: '1px solid var(--green-primary)',
        }}>
          <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8 }}>
            Пароль для {issued.email} — показывается один раз
          </div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <code style={{
              fontSize: 18, fontWeight: 700, letterSpacing: 0.5,
              background: 'var(--white)', border: '1px solid var(--border)',
              borderRadius: 'var(--radius)', padding: '7px 12px', userSelect: 'all',
            }}>{issued.password}</code>
            <button className="btn btn-secondary btn-sm" onClick={() => copy(issued.password)}>
              {copied ? 'Скопировано' : 'Скопировать'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => setIssued(null)}>Скрыть</button>
          </div>
          {issued.expires_at && (
            <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 8, lineHeight: 1.55 }}>
              Действует до <b>{formatMoscow(issued.expires_at)}</b>. Передайте подрядчику вместе
              с почтой и ссылкой на приложение. Нигде не сохранён — потеряется, выдайте новый.
            </div>
          )}
        </div>
      )}

      {/* --- Доступа ещё нет --- */}
      {!row && !creating && (
        <>
          <p style={{ fontSize: 13, color: 'var(--text-muted)', lineHeight: 1.6, margin: '0 0 12px' }}>
            У «{contractorName}» нет кабинета. В кабинете подрядчик видит свои заявки
            с телефоном и UTM, свои квалы, встречи и договоры — и ничего больше:
            ни расхода, ни выручки, ни других подрядчиков.
          </p>
          <button className="btn btn-primary btn-sm" onClick={() => { setCreating(true); setPassword(generatePassword()) }}>
            Завести доступ
          </button>
        </>
      )}

      {!row && creating && (
        <>
          <div className="form-row">
            <div className="form-group">
              <label className="form-label">Почта подрядчика</label>
              <input
                className="form-input" type="email" value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="partner@example.com" autoFocus
              />
              <div className="form-hint">Она же логин. Заводите отдельную почту — не свою и не сотрудника.</div>
            </div>
            <div className="form-group">
              <label className="form-label">Пароль</label>
              <div style={{ display: 'flex', gap: 6 }}>
                <input
                  className="form-input" value={password}
                  onChange={e => setPassword(e.target.value)} style={{ fontFamily: 'monospace' }}
                />
                <button className="btn btn-secondary btn-sm" type="button" onClick={() => setPassword(generatePassword())}>
                  ↻
                </button>
              </div>
              <div className="form-hint">Можно задать свой. Не короче 8 символов.</div>
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button className="btn btn-primary btn-sm" onClick={createAccess} disabled={busy || !email.trim()}>
              {busy ? 'Заводим...' : 'Завести доступ'}
            </button>
            <button className="btn btn-ghost btn-sm" onClick={() => { setCreating(false); setError('') }}>
              Отмена
            </button>
          </div>
        </>
      )}

      {/* --- Доступ есть --- */}
      {row && (
        <>
          <div className="info-grid" style={{ marginBottom: 12 }}>
            <div className="info-item">
              <div className="info-item-label">Логин</div>
              <div className="info-item-value td-mono">{row.email}</div>
            </div>
            <div className="info-item">
              <div className="info-item-label">Пароль выдан</div>
              <div className="info-item-value">{row.выдан ? formatMoscow(row.выдан) : '—'}</div>
            </div>
            <div className="info-item">
              <div className="info-item-label">Действует до</div>
              <div className="info-item-value">
                {row.действует_до ? formatMoscow(row.действует_до) : '—'}
                {row.дней_осталось != null && (
                  <span style={{ color: 'var(--text-muted)', fontWeight: 400 }}> · {row.дней_осталось} дн.</span>
                )}
              </div>
            </div>
          </div>

          {!confirmRevoke ? (
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button className="btn btn-primary btn-sm" onClick={issuePassword} disabled={busy}>
                {busy ? 'Выдаём...' : 'Выдать новый пароль'}
              </button>
              <button className="btn btn-secondary btn-sm" onClick={toggleSuspend} disabled={busy}>
                {row.состояние === 'доступ приостановлен' ? 'Возобновить' : 'Приостановить'}
              </button>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmRevoke(true)} disabled={busy}>
                Закрыть доступ
              </button>
            </div>
          ) : (
            <div className="alert alert-warning">
              <div style={{ marginBottom: 8 }}>
                Закрыть доступ «{contractorName}» насовсем? Кабинет и учётная запись будут
                удалены. Если нужно временно — есть «Приостановить».
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <button className="btn btn-danger btn-sm" onClick={revoke} disabled={busy}>
                  {busy ? 'Закрываем...' : 'Да, закрыть'}
                </button>
                <button className="btn btn-ghost btn-sm" onClick={() => setConfirmRevoke(false)}>Отмена</button>
              </div>
            </div>
          )}

          <div style={{ fontSize: 11, color: 'var(--text-muted)', marginTop: 10, lineHeight: 1.6 }}>
            Пароль действует 31 день, после чего кабинет закрывается сам и подрядчик видит
            «срок доступа истёк». Сам сменить пароль он не может — это выданный доступ.
            Приостановка закрывает кабинет мгновенно, не удаляя его.
          </div>
        </>
      )}
    </div>
  )
}
