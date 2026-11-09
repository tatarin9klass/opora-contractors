import React, { useState } from 'react'

// ============================================================================
// Сортировка таблиц по столбцам.
//
// ПУСТЫЕ ЗНАЧЕНИЯ ВСЕГДА ВНИЗУ, в обе стороны. Если гонять их вместе со
// всеми, первый же щелчок по колонке с прочерками покажет страницу
// прочерков — формально верно, практически бесполезно: человек щёлкает,
// чтобы увидеть крайние значения, а не отсутствующие.
//
// ЧИСЛА СРАВНИВАЮТСЯ КАК ЧИСЛА, даже если пришли строкой. PostgREST отдаёт
// numeric строкой, и без приведения «1000» оказывалось бы меньше «9».
// ============================================================================

function пусто(v) {
  return v === null || v === undefined || v === '' || (typeof v === 'number' && isNaN(v));
}

function сравнить(a, b) {
  if (typeof a === 'number' && typeof b === 'number') return a - b
  const na = Number(a), nb = Number(b)
  if (!isNaN(na) && !isNaN(nb) && String(a).trim() !== '' && String(b).trim() !== '') return na - nb
  return String(a).localeCompare(String(b), 'ru')
}

export function useSort(defaultKey, defaultDir = 'desc') {
  const [sort, setSort] = useState({ key: defaultKey, dir: defaultDir })

  // Первый щелчок по новой колонке — по убыванию: у чисел интересны
  // большие значения, и ждать второго щелчка ради этого незачем. У
  // текстовой колонки наоборот, там естественно по алфавиту.
  const onSort = (key, textual = false) => setSort(s => (
    s.key === key
      ? { key, dir: s.dir === 'desc' ? 'asc' : 'desc' }
      : { key, dir: textual ? 'asc' : 'desc' }
  ))

  const apply = (rows) => [...rows].sort((x, y) => {
    const a = x[sort.key], b = y[sort.key]
    const ан = пусто(a), бн = пусто(b)
    if (ан || бн) return ан && бн ? 0 : ан ? 1 : -1
    return сравнить(a, b) * (sort.dir === 'desc' ? -1 : 1)
  })

  return { sort, onSort, apply }
}

export function Th({ sort, onSort, k, textual = false, className = '', children }) {
  const активна = sort.key === k
  return (
    <th
      className={`${className} th-sortable ${активна ? 'active' : ''}`}
      onClick={() => onSort(k, textual)}
      title="Сортировать по этому столбцу"
    >
      {children}
      <span className="th-arrow">{активна ? (sort.dir === 'desc' ? '↓' : '↑') : '↕'}</span>
    </th>
  )
}
