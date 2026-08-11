import { grandTotal, nonCacheTotal } from '../core/types.js'
import { count, tokens, usd } from '../report/format.js'
import type { Row } from './model.js'
import { bold, dim, grey, inverse, padEnd, providerColour, truncate } from './theme.js'
import { bar, fitColumns, headerRow, row, sparkline } from './widgets.js'

/**
 * Which measure a share table counts by.
 *
 * `all` is every token including cache; `nonCache` is input plus output alone. The overview draws
 * the same table twice, once each way, because the two orderings can disagree: a tool with a huge
 * cached context can dominate the first and barely register in the second.
 */
export type Measure = 'all' | 'nonCache'

export function shareRows(
  rows: Row[],
  width: number,
  selected: number,
  showTrend: boolean,
  measure: Measure = 'all',
): string[] {
  const size = (entry: Row): number =>
    measure === 'all' ? grandTotal(entry.totals) : nonCacheTotal(entry.totals)
  const costOf = (entry: Row): number => (measure === 'all' ? entry.cost : entry.nonCacheCost)
  const total = rows.reduce((sum, entry) => sum + size(entry), 0)
  const labelWidth = Math.min(22, Math.max(12, Math.floor(width * 0.2)))
  const trendWidth = showTrend && width > 96 ? 14 : 0
  // The share bar takes whatever the fixed columns leave. Widening it past that would push a real
  // number off the row, and the bar is the one thing here that carries no digits.
  const barWidth = Math.max(8, width - labelWidth - trendWidth - 46)

  const columns = fitColumns(
    [
      { header: 'Tool', width: labelWidth },
      { header: 'Share', width: barWidth, drop: 2 },
      { header: 'Tokens', width: 9, align: 'right' as const },
      { header: 'Msgs', width: 7, align: 'right' as const, drop: 3 },
      { header: 'Est. cost', width: 10, align: 'right' as const, drop: 1 },
      ...(trendWidth > 0 ? [{ header: 'Trend', width: trendWidth, drop: 4 }] : []),
    ],
    width,
  )

  const out = [headerRow(columns)]
  rows.forEach((entry, index) => {
    const share = total > 0 ? size(entry) / total : 0
    const colour = providerColour(entry.provider)
    const byHeader: Record<string, string> = {
      Tool: colour(truncate(entry.label, columns[0]?.width ?? labelWidth)),
      Share: colour(bar(share, columns.find((c) => c.header === 'Share')?.width ?? barWidth)),
      Tokens: tokens(size(entry)),
      Msgs: count(entry.totals.messages),
      'Est. cost': usd(costOf(entry)),
      Trend: grey(sparkline(entry.trend, trendWidth)),
    }
    const line = row(
      columns,
      columns.map((column) => byHeader[column.header] ?? ''),
    )
    out.push(index === selected ? inverse(padEnd(line, width)) : line)
  })
  return out
}

export function detailTable(
  rows: Row[],
  width: number,
  selected: number,
  heading: string,
  /** `tool` names the single owning tool; `tools` lists every contributor. */
  toolColumn?: 'tool' | 'tools',
): string[] {
  const labelWidth = Math.max(18, Math.min(44, width - 60))
  const columns = fitColumns(
    [
      { header: heading, width: labelWidth },
      // The same model can be reached through more than one tool, so without this the two rows are
      // identical apart from their colour, which is no help at all when colour is off.
      ...(toolColumn === undefined
        ? []
        : [{ header: toolColumn === 'tools' ? 'Tools' : 'Tool', width: 18, drop: 2 }]),
      { header: 'Input', width: 9, align: 'right' as const, drop: 5 },
      { header: 'Output', width: 9, align: 'right' as const, drop: 4 },
      { header: 'Cache W', width: 9, align: 'right' as const, drop: 7 },
      { header: 'Cache R', width: 9, align: 'right' as const, drop: 6 },
      { header: 'In+out', width: 9, align: 'right' as const, drop: 8 },
      { header: 'Total', width: 9, align: 'right' as const },
      { header: 'Msgs', width: 7, align: 'right' as const, drop: 3 },
      { header: 'Est. cost', width: 10, align: 'right' as const, drop: 1 },
    ],
    width,
  )

  const out = [headerRow(columns)]
  rows.forEach((entry, index) => {
    const colour = entry.provider === '' ? bold : providerColour(entry.provider)
    const byHeader: Record<string, string> = {
      [heading]: colour(truncate(entry.label, columns[0]?.width ?? labelWidth)),
      Tool: dim(truncate(entry.provider, 18)),
      Tools: dim(truncate(entry.providers.join(', ') || '-', 18)),
      Input: tokens(entry.totals.input),
      Output: tokens(entry.totals.output),
      'Cache W': tokens(entry.totals.cacheWrite5m + entry.totals.cacheWrite1h),
      'Cache R': tokens(entry.totals.cacheRead),
      'In+out': tokens(nonCacheTotal(entry.totals)),
      Total: tokens(grandTotal(entry.totals)),
      Msgs: count(entry.totals.messages),
      'Est. cost': usd(entry.cost),
    }
    const line = row(
      columns,
      columns.map((column) => byHeader[column.header] ?? ''),
    )
    out.push(index === selected ? inverse(padEnd(line, width)) : line)
  })
  return out
}
