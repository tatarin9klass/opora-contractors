import React, { useState } from 'react'

const FUNCTION_URL = 'https://jgmuuehxavwlrfkonnzx.supabase.co/functions/v1/rop-deals'
const ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImpnbXV1ZWh4YXZ3bHJma29ubnp4Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODIwNzY4MzAsImV4cCI6MjA5NzY1MjgzMH0.BvX2ZBVSs17Vuwq_ok_e_QyAck0FG2yYTtuOkbaUrqU'

const PHASES = {
  deals: 'сделки', deals_open: 'открытые сделки',
  products: 'состав услуг', stages: 'история этапов',
  verify: 'сверка с Битриксом', idle: 'готово',
}

// Предел проходов. Он существует только чтобы кнопка не ходила по кругу
// вечно при поломке на той стороне, а не чтобы ограничивать объём: обычная
// догрузка укладывается в один-два прохода, полная — в десяток.
//
// Раньше предел был двадцать, и это было опасно: при полном проходе на
// большом архиве цикл упирался в него и ОСТАНАВЛИВАЛСЯ МОЛЧА, оставляя
// половину данных. Теперь предел выше, а если он всё-таки достигнут —
// экран говорит об этом прямо.
const MAX_PASSES = 60

export default function RopImportButton({ compact = false, onDone }) {
  const [loading, setLoading] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const [stopped, setStopped] = useState(false)

  async function run(full) {
    setLoading(true); setError(null); setResult(null); setStopped(false)
    try {
      let body = full ? { full: true } : {}
      // Счётчики в ответе — за один проход: функция о предыдущих вызовах
      // не знает. Складываем здесь, иначе на экране будет последний кусок
      // вместо итога.
      const totals = { deals: 0, products: 0, stages: 0, removed: 0 }
      let завершено = false
      for (let pass = 1; pass <= MAX_PASSES; pass++) {
        const res = await fetch(FUNCTION_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${ANON_KEY}`,
            'apikey': ANON_KEY,
          },
          body: JSON.stringify(body),
        })
        const json = await res.json()
        if (!json.success) { setError(json.error || 'Неизвестная ошибка'); break }
        // Другой проход уже идёт: не ошибка, но продолжать нельзя —
        // одновременная запись портит товарные позиции.
        if (json.busy) { setError(json.error_hint || 'Загрузка уже идёт'); break }
        totals.deals += Number(json.deals_upserted || 0)
        totals.products += Number(json.products_upserted || 0)
        totals.stages += Number(json.stages_upserted || 0)
        totals.removed += Number(json.removed || 0)
        setResult({ ...json, pass, totals: { ...totals } })
        if (json.done) { завершено = true; break }
        body = {}
      }
      if (!завершено) setStopped(true)
      if (завершено && onDone) onDone()
    } catch (e) {
      setError(String(e))
    }
    setLoading(false)
  }

  return (
    <div className={compact ? 'rop-import compact' : 'rop-import'}>
      <div className="rop-import-row">
        <button className="btn btn-primary btn-sm" onClick={() => run(false)} disabled={loading}>
          {loading ? 'Загружаем...' : '🔄 Обновить сделки'}
        </button>
        {/* Полный проход нужен редко: правку товарной позиции Битрикс не
            всегда отражает в дате изменения сделки, и раз в месяц архив
            стоит перечитать целиком. Делать это каждый раз незачем — на
            большой базе такой проход идёт минутами. */}
        <button className="btn btn-secondary btn-sm" onClick={() => run(true)} disabled={loading}
                title="Перечитать всю воронку заново. Нужно редко — примерно раз в месяц.">
          Перезагрузить всё
        </button>
        {loading && result && (
          <span className="portal-muted" style={{ fontSize: 12 }}>
            проход {result.pass} · {PHASES[result.phase] || result.phase}
          </span>
        )}
      </div>

      {error && <div className="alert alert-danger" style={{ marginTop: 10 }}>🔴 Ошибка загрузки: {error}</div>}

      {stopped && !error && (
        <div className="alert alert-warning" style={{ marginTop: 10 }}>
          Загрузка не дошла до конца за {MAX_PASSES} проходов и остановлена.
          Данные частично обновлены, прогресс сохранён — нажмите «Обновить
          сделки» ещё раз, загрузка продолжится с того же места.
        </div>
      )}

      {result && !error && !stopped && (
        <div className="alert alert-info" style={{ marginTop: 10 }}>
          {result.done
            ? `✅ Готово за ${result.pass} ${result.pass === 1 ? 'проход' : result.pass < 5 ? 'прохода' : 'проходов'}`
            : `Идёт ${PHASES[result.phase] || result.phase}`}
          {result.mode === 'full' ? ' · полный проход' : ''}.
          {' '}Сделок {result.totals?.deals ?? 0}, позиций {result.totals?.products ?? 0},
          {' '}записей истории {result.totals?.stages ?? 0}.
          {result.totals?.removed
            ? ` Удалено исчезнувших из Битрикса: ${result.totals.removed}.`
            : ''}
        </div>
      )}
    </div>
  )
}
