import React, { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useAuth } from '../lib/auth.jsx'

// ============================================================================
// Обязательная смена пароля: первый вход по временному паролю и ежемесячная
// ротация.
//
// ЭКРАН НИЧЕГО НЕ ЗАЩИЩАЕТ, И ЭТО ВАЖНО ПОНИМАТЬ. Доступ к данным обрывается
// в базе — функция current_contractor_id() не возвращает подрядчика, пока
// поднят флаг must_change_password, поэтому все вьюхи кабинета отдают ноль
// строк. Даже если этот экран обойти (запросом мимо интерфейса, публичный
// ключ лежит в коде страницы), данных за ним нет. Здесь только объяснение,
// почему кабинет пуст, и поле для нового пароля.
//
// ФЛАГ СНИМАЕТ БАЗА, А НЕ ЭТА СТРАНИЦА. На auth.users стоит триггер: пароль
// действительно сменился в GoTrue — флаг снят, срок продлён на месяц.
// Подделать это из браузера нельзя, поэтому после успешной смены мы просто
// перечитываем профиль.
// ============================================================================

const MIN_LENGTH = 10

export default function PasswordChangePage() {
  const { session, profile, reloadProfile, signOut } = useAuth()
  const [pw1, setPw1] = useState('')
  const [pw2, setPw2] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)

  const firstTime = !profile?.password_rotated_at

  async function handleSubmit(e) {
    e.preventDefault()
    setError('')
    if (pw1.length < MIN_LENGTH) {
      setError(`Пароль должен быть не короче ${MIN_LENGTH} символов`)
      return
    }
    if (pw1 !== pw2) {
      setError('Пароли не совпадают')
      return
    }
    setSaving(true)
    const { error: upErr } = await supabase.auth.updateUser({ password: pw1 })
    if (upErr) {
      setSaving(false)
      // Самая частая причина — Supabase не принимает пароль, совпадающий с
      // текущим. Говорим это прямо, иначе человек будет вводить тот же пароль
      // по кругу.
      setError(
        /same|different/i.test(upErr.message || '')
          ? 'Новый пароль должен отличаться от прежнего'
          : `Не удалось сменить пароль: ${upErr.message}`,
      )
      return
    }

    // Флаг снимает база, а не эта страница. Функция сама сверяет отпечаток
    // пароля и откажет, если он не изменился, — поэтому обойти экран,
    // вызвав её из консоли, бессмысленно.
    const { error: rpcErr } = await supabase.rpc('portal_confirm_password_change')
    if (rpcErr) {
      setSaving(false)
      setError(rpcErr.message)
      return
    }

    await reloadProfile()
    setSaving(false)
  }

  return (
    <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'var(--bg)' }}>
      <form onSubmit={handleSubmit} style={{ background: 'var(--white)', border: '1px solid var(--border)', borderRadius: 'var(--radius-lg)', padding: 32, width: 380 }}>
        <h1 style={{ fontSize: 20, fontWeight: 700, marginBottom: 4, color: 'var(--green-dark)' }}>
          {firstTime ? 'Задайте свой пароль' : 'Пора сменить пароль'}
        </h1>
        <p style={{ fontSize: 13, color: 'var(--text-muted)', marginBottom: 18, lineHeight: 1.5 }}>
          {firstTime
            ? 'Вы вошли по временному паролю. Задайте свой — временный после этого перестанет работать, и ваш пароль не будет известен никому, кроме вас.'
            : 'Пароли в кабинете меняются раз в месяц. Пока новый не задан, статистика не открывается.'}
        </p>
        <div className="form-group">
          <label className="form-label">Новый пароль</label>
          <input
            className="form-input"
            type="password"
            value={pw1}
            onChange={e => setPw1(e.target.value)}
            required
            autoFocus
            autoComplete="new-password"
          />
          <div className="form-hint">Не короче {MIN_LENGTH} символов</div>
        </div>
        <div className="form-group">
          <label className="form-label">Повторите пароль</label>
          <input
            className="form-input"
            type="password"
            value={pw2}
            onChange={e => setPw2(e.target.value)}
            required
            autoComplete="new-password"
          />
        </div>
        {error && <div className="alert alert-danger" style={{ marginBottom: 12 }}>{error}</div>}
        <button className="btn btn-primary" type="submit" disabled={saving} style={{ width: '100%' }}>
          {saving ? 'Сохраняем...' : 'Сохранить и войти'}
        </button>
        <div style={{ marginTop: 14, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>{session?.user?.email}</span>
          <button type="button" className="btn btn-ghost btn-sm" onClick={signOut}>Выйти</button>
        </div>
      </form>
    </div>
  )
}
