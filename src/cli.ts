#!/usr/bin/env node
import { runDisable, runEnable } from './commands/autostart.js'
import { runDaemon } from './commands/daemon.js'
import { applyConfig } from './core/config.js'

import { runProviders } from './commands/providers.js'
import { runReset } from './commands/reset.js'
import { runScan } from './commands/scan.js'
import { runStart } from './commands/start.js'
import { runStats } from './commands/stats.js'
import { runStatus } from './commands/status.js'
import { runStatusline } from './commands/statusline.js'
import { runStop } from './commands/stop.js'
import { runTelemetry } from './commands/telemetry.js'
import { runUi } from './commands/ui.js'
import { runVerify } from './commands/verify.js'
import { isInteractive } from './tui/screen.js'
import { parseArgs } from './util/args.js'
import { VERSION } from './version.js'

const HELP = `tikr - track Claude Code token usage

Usage:
  tikr                 open the interactive dashboard
  tikr <command> [options]

Commands:
  start              Index existing usage, start the background service, and run it at login
  stop               Stop the background service    (--disable also removes it from startup)
  status             Show service state and where data is kept
  providers          Which AI tools are tracked, and which cannot be
  stats              Show recorded usage
  statusline         One line of usage for Claude Code's prompt  (--install prints the setup)
  ui                 Interactive dashboard (also the default with no command)
  scan               Run one ingest pass now        (--dry-run writes nothing)
  enable             Register to start at login
  disable            Remove the startup registration
  verify             Check the encrypted history is intact  (--rebuild repairs the cache)
  telemetry          How to have Claude Code push usage here as it happens
  reset              Delete all recorded statistics (requires --yes)

Options:
  --interval <sec>   Seconds between scans (default 15)         [start, enable, daemon]
  --last <n>         Periods to include, 0 for all (default 30) [stats]
  --since <date>     Start of the window, YYYY-MM-DD            [stats]
  --until <date>     End of the window, YYYY-MM-DD              [stats]
  --by <group>       model|provider|day|week|month|project|block|hour  [stats]
  --week-start <day> monday (default) or sunday                 [stats]
  --block-hours <n>  Length of a usage block (default 5)         [stats]
  --json             Machine-readable output                    [stats]
  --csv              Spreadsheet-ready output                   [stats]
  --no-scan          Report stored numbers without scanning     [stats]
  --no-autostart     Start the service without registering it   [start]
  --no-backfill      Start counting from now, ignore past history [start, scan]
  --otlp             Receive live telemetry from Claude Code    [start, enable]
  --otlp-port <n>    Port for the receiver (default 4318)       [start, enable, telemetry]

  --dry-run          Ingest but write nothing                   [scan]
  --verbose          Extra detail                               [scan, stats]
  --install          Print the setup to add, without editing it [statusline]
  --rebuild          Restore the cache from the ledger          [verify]

Configuration:
  Optional defaults live in ~/.tikr/config.json. A flag always wins over it.

Data:
  Usage is read from each tool's own local session files and stored in ~/.tikr.
  Nothing is sent anywhere. Run \`tikr providers\` to see what is being tracked.

  The service watches those files, so a new message is counted about a second after Claude Code
  writes it. \`tikr telemetry\` sets up an additional push feed with Claude Code's own
  cost figure and a main/subagent split.
`

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2))
  // Defaults from ~/.tikr/config.json fill only the flags the user did not type, so
  // precedence is settled here once rather than in each command.
  applyConfig(args, args.command)

  if (args.command === 'version') {
    console.log(`tikr ${VERSION}`)
    return 0
  }
  if (args.flags.has('help') || args.command === 'help') {
    console.log(HELP)
    return 0
  }
  // Checked before the bare-invocation branch below, which would otherwise swallow `--version`
  // into the help text whenever stdout is not a terminal.
  if (args.flags.has('version')) {
    console.log(`tikr ${VERSION}`)
    return 0
  }
  // Bare invocation opens the interactive view on a terminal, and prints help when piped, so the
  // default is useful interactively without emitting escape sequences into a file.
  if (args.command === '') {
    if (!isInteractive()) {
      console.log(HELP)
      return 0
    }
    return runUi(args)
  }

  switch (args.command) {
    case 'start':
      return runStart(args)
    case 'stop':
      return runStop(args)
    case 'status':
      return runStatus()
    case 'providers':
      return runProviders()
    case 'stats':
      return runStats(args)
    case 'statusline':
      return runStatusline(args)
    case 'live':
    case 'ui':
      return runUi(args)
    case 'telemetry':
      return runTelemetry(args)
    case 'verify':
      return runVerify(args)
    case 'scan':
      return runScan(args)
    case 'enable':
      return runEnable(args)
    case 'disable':
      return runDisable()
    case 'reset':
      return runReset(args)
    case 'daemon':
      // Internal: the foreground service loop. `start` spawns this; users do not call it directly.
      return runDaemon(args)
    default:
      console.error(`Unknown command "${args.command}". Run \`tikr --help\`.`)
      return 1
  }
}

main()
  .then((code) => {
    process.exitCode = code
  })
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    process.exitCode = 1
  })
