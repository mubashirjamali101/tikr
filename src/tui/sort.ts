import { grandTotal } from '../core/types.js'
import type { Row } from './model.js'

export type SortKey = 'tokens' | 'cost' | 'messages' | 'name'

export const SORTS: SortKey[] = ['tokens', 'cost', 'messages', 'name']

export const SORT_LABEL: Record<SortKey, string> = {
  tokens: 'tokens',
  cost: 'cost',
  messages: 'messages',
  name: 'name',
}

export function nextSort(current: SortKey): SortKey {
  return SORTS[(SORTS.indexOf(current) + 1) % SORTS.length] ?? 'tokens'
}

/**
 * Order rows for display.
 *
 * Numeric sorts are descending because the question is always "what is using the most"; `name` is
 * ascending because it exists to find a specific row, not to rank. Sorting is done on a copy so a
 * view never mutates the snapshot it was handed.
 */
export function sortRows(rows: Row[], key: SortKey): Row[] {
  const copy = [...rows]
  switch (key) {
    case 'cost':
      return copy.sort((a, b) => b.cost - a.cost)
    case 'messages':
      return copy.sort((a, b) => b.totals.messages - a.totals.messages)
    case 'name':
      return copy.sort((a, b) => a.label.localeCompare(b.label))
    default:
      return copy.sort((a, b) => grandTotal(b.totals) - grandTotal(a.totals))
  }
}

/**
 * The days view is a timeline, so it stays in date order however the rest is sorted.
 *
 * Re-ranking a chronological axis by size destroys the only thing it is for. `name` is still
 * honoured there because on that view the name *is* the date.
 */
export function sortForDays(rows: Row[], key: SortKey): Row[] {
  if (key === 'name') return [...rows].sort((a, b) => a.label.localeCompare(b.label))
  return rows
}
