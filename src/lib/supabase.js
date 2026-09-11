import { createClient } from '@supabase/supabase-js'

const SUPABASE_URL = 'https://jgmuuehxavwlrfkonnzx.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpnbXV1ZWh4YXZ3bHJma29ubnp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNzY4MzAsImV4cCI6MjA5NzY1MjgzMH0.BvX2ZBVSs17Vuwq_ok_e_QyAck0FG2yYTtuOkbaUrqU'

export const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY)

// PostgREST отдаёт максимум 1000 строк на запрос (db-max-rows в Supabase) и
// делает это МОЛЧА — без ошибки, просто обрезая хвост. Для daily_facts это
// давно не гипотетический предел: строка на каждый (день × источник), то есть
// ~20 активных источников × 60 дней это уже больше тысячи, и метрики за
// длинный период занижались без единого признака поломки.
//
// buildQuery — функция, возвращающая НОВЫЙ query builder на каждый вызов
// (builder одноразовый, повторно его использовать нельзя).
export async function fetchAllRows(buildQuery, pageSize = 1000) {
  const out = []
  for (let from = 0; ; from += pageSize) {
    const { data, error } = await buildQuery().range(from, from + pageSize - 1)
    if (error) throw error
    if (!data || data.length === 0) break
    out.push(...data)
    if (data.length < pageSize) break
  }
  return out
}
