import { supabase, fetchAllRows } from './supabase.js'

// Общие данные направления АВТОПРАВО/АВАРКОМ. Вынесено отдельно, потому что
// одни и те же четыре справочника нужны и списку каналов, и паспорту канала.
//
// Витрина ap_monthly_stats построена на CTE — PostgREST не умеет делать
// resource embedding поверх таких вьюх (возвращает 400), поэтому связь
// "источник → канал" собираем на клиенте, а не через select('*, ap_sources(...)').

export const DIRECTIONS = [
  { id: 'avtpr', label: 'АВТОПРАВО' },
  { id: 'avrkm', label: 'АВАРКОМ' },
]

export function monthKeyOf(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-01`
}

export function monthLabel(m) {
  if (!m) return '—'
  return new Date(m).toLocaleString('ru-RU', { month: 'long', year: 'numeric' })
}

export async function loadAvtpData() {
  const [{ data: channels }, { data: sources }, stats, { data: expenses }] = await Promise.all([
    supabase.from('ap_channels').select('*').order('sort_order'),
    supabase.from('ap_sources').select('*').order('bitrix_name'),
    fetchAllRows(() => supabase.from('ap_monthly_stats').select('*')),
    supabase.from('ap_monthly_expenses').select('*'),
  ])
  return {
    channels: channels || [],
    sources: sources || [],
    stats: stats || [],
    expenses: expenses || [],
  }
}

// Список месяцев, по которым вообще есть хоть что-то (факт или расход),
// от свежих к старым.
export function availableMonths({ stats, expenses }) {
  const set = new Set()
  for (const s of stats) if (s.month) set.add(s.month)
  for (const e of expenses) if (e.month) set.add(e.month)
  return [...set].sort().reverse()
}

export function cpo(spend, contracts) {
  if (!contracts) return null
  return spend / contracts
}

// Сводка по каналам за месяц. Источник, не привязанный ни к одному каналу,
// не теряется — он попадает в псевдоканал с channelId = null, и его видно
// на экране отдельной строкой «Без канала».
export function aggregateChannels({ channels, sources, stats, expenses }, month) {
  const sourceToChannel = new Map()
  for (const s of sources) sourceToChannel.set(s.bitrix_name, s.channel_id)

  const spendByChannel = new Map()
  for (const e of expenses) {
    if (e.month !== month) continue
    spendByChannel.set(e.channel_id, (spendByChannel.get(e.channel_id) || 0) + Number(e.spend || 0))
  }

  const acc = new Map()
  function bucket(channelId) {
    if (!acc.has(channelId)) acc.set(channelId, { leads: 0, contracts: 0 })
    return acc.get(channelId)
  }

  for (const row of stats) {
    if (row.month !== month) continue
    const channelId = sourceToChannel.get(row.source_name) ?? null
    const b = bucket(channelId)
    b.leads += row.leads || 0
    b.contracts += row.contracts || 0
  }

  const out = channels.map(c => {
    const b = acc.get(c.id) || { leads: 0, contracts: 0 }
    const spend = spendByChannel.get(c.id) || 0
    return {
      channelId: c.id,
      name: c.name,
      direction: c.direction,
      sort_order: c.sort_order,
      spend,
      leads: b.leads,
      contracts: b.contracts,
      cpo: cpo(spend, b.contracts),
    }
  })

  const orphan = acc.get(null)
  if (orphan && (orphan.leads > 0 || orphan.contracts > 0)) {
    out.push({
      channelId: null,
      name: 'Без канала',
      direction: 'avtpr',
      sort_order: 9999,
      spend: 0,
      leads: orphan.leads,
      contracts: orphan.contracts,
      cpo: null,
    })
  }

  return out
}

// Разрез по источникам внутри одного канала за месяц. Цены здесь не
// показываются: расход вводится на канал целиком, делить его между
// источниками нечем и незачем.
export function aggregateSources({ sources, stats }, channelId, month) {
  const own = sources.filter(s => s.channel_id === channelId)
  const byName = new Map()
  for (const row of stats) {
    if (row.month !== month) continue
    byName.set(row.source_name, { leads: row.leads || 0, contracts: row.contracts || 0 })
  }
  return own.map(s => ({
    id: s.id,
    name: s.bitrix_name,
    leads: byName.get(s.bitrix_name)?.leads || 0,
    contracts: byName.get(s.bitrix_name)?.contracts || 0,
  }))
}
