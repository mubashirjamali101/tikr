import type { Block, BurnRate } from '../core/blocks.js'
import { duration, tokens, usd } from './format.js'

/**
 * One line for Claude Code's prompt.
 *
 * Pure formatting so it can be tested without a terminal, a state file, or a clock. Fields are
 * dropped from the right as the terminal narrows, because the leftmost figures are the ones a user
 * glances at. No icons and no emoji: the separator is two spaces.
 */

export interface StatuslineInput {
  model: string | null
  sessionCostUsd: number | null
  todayCostUsd: number
  block: Block | null
  burn: BurnRate | null
  now: Date
}

function fields(input: StatuslineInput): string[] {
  const out: string[] = []
  if (input.model !== null) out.push(input.model)
  if (input.sessionCostUsd !== null) out.push(`session ${usd(input.sessionCostUsd)}`)
  out.push(`today ${usd(input.todayCostUsd)}`)
  if (input.block !== null) {
    const left = duration(input.block.endsAt.getTime() - input.now.getTime())
    out.push(`block ${usd(input.block.costUsd)} (${left} left)`)
  }
  if (input.burn !== null) out.push(`${tokens(input.burn.tokensPerMinute)} tok/min`)
  return out
}

export function renderStatusline(input: StatuslineInput, width = 200): string {
  const all = fields(input)
  // Keep at least the first field, whatever the width: an empty statusline reads as a broken tool.
  for (let keep = all.length; keep > 1; keep -= 1) {
    const line = all.slice(0, keep).join('  ')
    if (line.length <= width) return line
  }
  return all[0] ?? ''
}
