import { supabase, fetchAllRows } from './supabase.js'

// Даты берём те же, что у кабинета РОПа: один расчёт периодов на
// приложение. Свой завёл бы вторую отчётную неделю, и две вкладки за один
// и тот же «месяц» показывали бы разное.
export { periodBounds, recentMonths, monthBounds } from './rop.js'

// ============================================================================
// Данные агентской сети.
//
// ЧТО СЧИТАЕТСЯ ПРИВЕДЁННЫМ, РЕШАЕТ БАЗА, А НЕ ЭТОТ ФАЙЛ. Правило «агент
// считается всегда, „Агент не найден“ — только при префиксе agbfl, „Без
// агента“ — никогда» живёт в функции agent_counts и применено внутри
// витрины. Повторять его здесь значило бы завести второе место, где его
// можно забыть поправить.
// ============================================================================

export async function loadAgents(fromISO, toISO) {
  const [funnel, flow, daily, overdue] = await Promise.all([
    fetchAllRows(() => supabase.from('agents_portal_funnel').select('*').order('sort_order')),
    fetchAllRows(() => supabase.from('agents_portal_flow').select('*')
      .gte('дата', fromISO).lte('дата', toISO)),
    fetchAllRows(() => supabase.from('agents_portal_daily').select('*')
      .gte('дата', fromISO).lte('дата', toISO)),
    fetchAllRows(() => supabase.from('agents_portal_overdue').select('*')),
  ])
  return { funnel, flow, daily, overdue }
}

const ZERO = { лиды: 0, квалы: 0, встречи: 0, сделки: 0, выручка: 0 }

export function totals(rows) {
  const t = { ...ZERO }
  for (const r of rows) for (const k of Object.keys(ZERO)) t[k] += Number(r[k] || 0)
  return t
}

// Средний чек на сделку. Отдельной метрикой «AOV» на экране, потому что
// выручка сама по себе не говорит, крупные клиенты у агента или много
// мелких.
export function aov(t) {
  return t.сделки ? Math.round(t.выручка / t.сделки) : null
}

// Движение по стадиям за период: вход и выход сложены по каждой стадии.
export function flowByStage(flow) {
  const by = new Map()
  for (const r of flow) {
    const c = by.get(r.stage_id) || { вошло: 0, вышло: 0 }
    c.вошло += Number(r.вошло || 0)
    c.вышло += Number(r.вышло || 0)
    by.set(r.stage_id, c)
  }
  return by
}

export function byPrefix(rows) {
  const by = new Map()
  for (const r of rows) {
    const k = r.префикс || 'прочее'
    const c = by.get(k) || { префикс: k, ...ZERO }
    for (const m of Object.keys(ZERO)) c[m] += Number(r[m] || 0)
    by.set(k, c)
  }
  return [...by.values()].sort((a, b) => b.лиды - a.лиды || b.сделки - a.сделки)
}

// Сводка по агентам, и у каждого — развёртка по префиксам.
//
// РАЗВЁРТКА ЗДЕСЬ НЕ УКРАШЕНИЕ. Агент, у которого часть лидов пришла не
// через agbfl, передал их мимо своего канала: выплата по ним не
// начислится, а он об этом не знает. Увидеть это можно только в разрезе
// префиксов конкретного человека, в общей цифре оно растворяется.
export function byAgent(rows) {
  const by = new Map()
  for (const r of rows) {
    const id = r.agent_id ?? 0
    let c = by.get(id)
    if (!c) {
      c = { agent_id: id, агент: r.агент || 'без карточки', вид: r.вид, ...ZERO, префиксы: new Map() }
      by.set(id, c)
    }
    for (const m of Object.keys(ZERO)) c[m] += Number(r[m] || 0)
    const p = r.префикс || 'прочее'
    const pc = c.префиксы.get(p) || { префикс: p, ...ZERO }
    for (const m of Object.keys(ZERO)) pc[m] += Number(r[m] || 0)
    c.префиксы.set(p, pc)
  }
  return [...by.values()]
    .map(a => ({
      ...a,
      префиксы: [...a.префиксы.values()].sort((x, y) => y.лиды - x.лиды || y.сделки - x.сделки),
      // Доля лидов, переданных не агентским каналом. Именно про неё
      // разговор с агентом, а не про «мало привёл».
      мимо: a.лиды
        ? Math.round(100 * (a.лиды - (a.префиксы.get('agbfl')?.лиды || 0)) / a.лиды)
        : 0,
    }))
    .sort((a, b) => b.лиды - a.лиды || a.агент.localeCompare(b.агент))
}

export function pct(a, b) {
  if (!b) return null
  return Math.round((1000 * a) / b) / 10
}

// Просрочки по лидам.
//
// ПОРОГИ НАКОПИТЕЛЬНЫЕ, как и спрошено: «более 30» включает и тех, кто
// молчит сто дней. Списки под плитками такие же накопительные — иначе
// число в плитке и длина списка под ней не совпадали бы, и экран пришлось
// бы объяснять словами.
//
// Агент без единого лида — отдельная строка, а не просрочка на девяносто
// дней. Его не возвращают, его впервые активируют, и это другой разговор.
export function overdueBuckets(rows) {
  const живые = rows.filter(r => r.лидов_всего > 0)
  const bucket = (days) => живые
    .filter(r => Number(r.дней_без_лида) > days)
    .sort((a, b) => Number(b.дней_без_лида) - Number(a.дней_без_лида))
  return {
    d30: bucket(30),
    d60: bucket(60),
    d90: bucket(90),
    никогда: rows.filter(r => !r.лидов_всего)
      .sort((a, b) => String(a.агент || '').localeCompare(String(b.агент || ''))),
    всего: rows.length,
  }
}
