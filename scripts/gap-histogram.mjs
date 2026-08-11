#!/usr/bin/env node
// Measures the gap between consecutive entries sharing a series key, for the bare message id and
// for the composite `messageId:requestId`.
//
// The ingest fold remembers only the most recent series per file, which is correct only because a
// message's repeated entries are strictly consecutive. That is a property of Claude Code's writer,
// not a guarantee, so this is the check to re-run after a large version jump: every gap must be 1.
// Anything larger means the fold is silently undercounting and `retention` has to change.
//
//   node scripts/gap-histogram.mjs
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const root = join(homedir(), '.claude', 'projects')
const files = []
const walk = (dir, depth = 0) => {
  if (depth > 6) return
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) walk(path, depth + 1)
    else if (entry.name.endsWith('.jsonl')) files.push(path)
  }
}
walk(root)

const gaps = { bare: new Map(), composite: new Map() }
let entries = 0
let withRequestId = 0

for (const file of files) {
  const lastSeen = { bare: new Map(), composite: new Map() }
  let index = 0
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    continue
  }
  for (const line of raw.split('\n')) {
    if (!line.includes('"assistant"')) continue
    let record
    try {
      record = JSON.parse(line)
    } catch {
      continue
    }
    if (record.type !== 'assistant') continue
    const id = record.message?.id
    if (typeof id !== 'string') continue
    if (record.message?.model === '<synthetic>') continue
    entries += 1
    if (typeof record.requestId === 'string') withRequestId += 1
    index += 1
    for (const [kind, key] of [
      ['bare', id],
      ['composite', `${id}:${record.requestId ?? ''}`],
    ]) {
      const previous = lastSeen[kind].get(key)
      if (previous !== undefined) {
        const gap = index - previous
        gaps[kind].set(gap, (gaps[kind].get(gap) ?? 0) + 1)
      }
      lastSeen[kind].set(key, index)
    }
  }
}

console.log(`files ${files.length}  assistant entries ${entries}  with requestId ${withRequestId}`)
for (const kind of ['bare', 'composite']) {
  const histogram = [...gaps[kind].entries()].sort(([a], [b]) => a - b)
  console.log(
    `${kind}: repeats ${histogram.reduce((sum, [, n]) => sum + n, 0)}  gaps ${JSON.stringify(histogram)}`,
  )
}
