import { PROVIDERS } from '../providers/registry.js'
import { count } from '../report/format.js'

/**
 * Tools that were investigated and cannot be tracked from local files.
 *
 * Listed explicitly, with the reason, so the absence reads as a finding rather than an oversight.
 * Each was checked against a real installation on 2026-08-11.
 */
const UNSUPPORTED: Array<{ name: string; reason: string }> = [
  { name: 'OpenCode', reason: 'no token fields in its storage, state, or desktop app data' },
  { name: 'Antigravity', reason: 'state is protobuf with no published schema' },
  { name: 'Cursor', reason: 'usage is accounted server-side; the local DB holds chat, not tokens' },
  { name: 'Goose', reason: 'only auth tokens on disk, no usage records' },
  { name: 'Gemini CLI', reason: 'only auth tokens on disk, no usage records' },
]

/** What is tracked, what is not, and why. */
export function runProviders(): number {
  console.log('Tracked')
  for (const provider of PROVIDERS) {
    const installed = provider.installed()
    const files = installed ? provider.discover().length : 0
    const state = installed ? `${count(files)} session files` : 'not installed'
    console.log(`  ${provider.name.padEnd(20)} ${state}`)
    console.log(`  ${''.padEnd(20)} ${provider.root()}`)
  }

  console.log('')
  console.log('Not trackable from local files')
  for (const entry of UNSUPPORTED) {
    console.log(`  ${entry.name.padEnd(20)} ${entry.reason}`)
  }

  console.log('')
  console.log('A tool is only added once its on-disk format has been verified against real data.')
  console.log('Guessing a format produces numbers that look plausible and are wrong, which is the')
  console.log('one failure this tool exists to prevent. See docs/PROVIDERS.md to add one.')
  return 0
}
