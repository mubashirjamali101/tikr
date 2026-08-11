import { identifyBlocks, lastActivity } from '../core/blocks.js'
import { activeBlock, burnRate } from '../core/burn.js'
import { today } from '../core/periods.js'
import { estimateCostByModel } from '../core/pricing.js'
import { findSessionFile, readSession } from '../core/session.js'
import { loadState } from '../core/state.js'
import { renderStatusline } from '../report/statusline.js'
import { type Args, flagBool } from '../util/args.js'

/** Claude Code renders the prompt on every turn, so the statusline must not dawdle. */
const STDIN_TIMEOUT_MS = 200

const SETUP = `Add this to ~/.claude/settings.json (or $CLAUDE_CONFIG_DIR/settings.json):

  {
    "statusLine": {
      "type": "command",
      "command": "tikr statusline",
      "padding": 0
    }
  }

The file is yours, so this prints the block rather than editing it.`

interface HookPayload {
  sessionId: string | null
  cwd: string | null
  model: string | null
}

/** Read the hook payload, giving up quickly: no payload simply means fewer fields on the line. */
async function readPayload(): Promise<HookPayload> {
  const empty: HookPayload = { sessionId: null, cwd: null, model: null }
  if (process.stdin.isTTY) return empty

  const raw = await new Promise<string>((resolve) => {
    let buffer = ''
    const timer = setTimeout(() => resolve(buffer), STDIN_TIMEOUT_MS)
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk) => {
      buffer += chunk
    })
    process.stdin.on('end', () => {
      clearTimeout(timer)
      resolve(buffer)
    })
    process.stdin.on('error', () => {
      clearTimeout(timer)
      resolve(buffer)
    })
  })

  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const model = parsed.model as Record<string, unknown> | undefined
    const workspace = parsed.workspace as Record<string, unknown> | undefined
    // Every field is read independently, so a renamed key upstream costs one field, not the line.
    return {
      sessionId: typeof parsed.session_id === 'string' ? parsed.session_id : null,
      cwd:
        typeof workspace?.current_dir === 'string'
          ? workspace.current_dir
          : typeof parsed.cwd === 'string'
            ? parsed.cwd
            : null,
      model:
        typeof model?.display_name === 'string'
          ? model.display_name
          : typeof model?.id === 'string'
            ? model.id
            : null,
    }
  } catch {
    return empty
  }
}

function sessionCost(payload: HookPayload): number | null {
  if (payload.sessionId === null) return null
  const path = findSessionFile(payload.sessionId, payload.cwd)
  if (path === null) return null
  return estimateCostByModel(readSession(path).byModel)
}

/**
 * One line of usage for Claude Code's status line.
 *
 * Reads state, never writes it, and never scans: the daemon owns ingestion. Any failure prints
 * nothing and exits 0, because a statusline that prints an error into the prompt is worse than one
 * that prints nothing.
 *
 * Measured at 151ms per invocation on real data (20 runs), of which 84ms is deriving the record
 * key: scrypt at 2^15 is deliberately slow, and a fresh process cannot reuse the cached key. The
 * remaining work - blocks, the active session fold, formatting - is 9ms. The alternative, a
 * plaintext summary file written by the daemon, was rejected: it would put usage figures on disk
 * unencrypted to save time the user cannot perceive between turns.
 */
export async function runStatusline(args: Args): Promise<number> {
  if (flagBool(args, 'install')) {
    console.log(SETUP)
    return 0
  }

  try {
    const payload = await readPayload()
    const { state } = loadState()
    const now = new Date()
    const blocks = identifyBlocks(state, { now })
    const block = activeBlock(blocks)

    console.log(
      renderStatusline(
        {
          model: payload.model,
          sessionCostUsd: sessionCost(payload),
          todayCostUsd: estimateCostByModel(state.daily[today(now)] ?? {}, today(now)),
          block,
          burn: block === null ? null : burnRate(block, lastActivity(state)),
          now,
        },
        process.stdout.columns ?? 200,
      ),
    )
  } catch {
    // Deliberately silent. See the note above.
  }
  return 0
}
