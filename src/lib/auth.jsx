import React, { createContext, useContext, useEffect, useState } from 'react'
import { supabase } from './supabase.js'

const AuthContext = createContext(null)

export function AuthProvider({ children }) {
  const [session, setSession] = useState(undefined) // undefined = ещё не проверили, null = не залогинен
  const [profile, setProfile] = useState(null)
  const [profileLoading, setProfileLoading] = useState(false)

  async function loadProfile(userId) {
    setProfileLoading(true)
    const { data } = await supabase.from('profiles').select('*').eq('id', userId).maybeSingle()
    setProfile(data || null)
    setProfileLoading(false)
  }

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session || null)
      if (data.session) loadProfile(data.session.user.id)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_event, newSession) => {
      setSession(newSession)
      if (newSession) loadProfile(newSession.user.id)
      else setProfile(null)
    })
    return () => sub.subscription.unsubscribe()
  }, [])

  const value = {
    session,
    profile,
    isAdmin: profile?.role === 'admin',
    // Подрядчик. Видит только свой кабинет и ни одного нашего экрана — не
    // потому что они скрыты в меню, а потому что база не отдаст ему данных
    // (см. миграцию 20261006_portal_1_rls_hardening). Проверка здесь — чтобы
    // показать правильный экран, а не чтобы что-то защитить.
    isContractor: profile?.role === 'contractor',
    // Пароль просрочен ежемесячной ротацией либо это первый вход по
    // временному паролю. Пока флаг поднят, база всё равно не отдаёт ни одной
    // строки — экран смены пароля просто объясняет, почему.
    mustChangePassword: !!profile?.must_change_password,
    // Профиль надо перечитать после смены пароля: флаг снимает функция в базе
    // (portal_confirm_password_change), и без перезагрузки кабинет остался бы
    // на экране смены.
    reloadProfile: () => (session ? loadProfile(session.user.id) : Promise.resolve()),
    // Пока сессия не проверена ИЛИ (есть сессия, но профиль ещё не подтянут) — не готовы рендерить страницы.
    loading: session === undefined || (!!session && profileLoading && !profile),
    signOut: () => supabase.auth.signOut(),
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export function useAuth() {
  return useContext(AuthContext)
}
