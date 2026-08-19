import { DEFAULT_OTLP_PORT } from '../otlp/receiver.js'
import { type Args, flagInt } from '../util/args.js'

/**
 * Print the environment Claude Code needs in order to push usage here.
 *
 * This deliberately prints rather than editing a shell profile: it changes how Claude Code itself
 * behaves in every future session, which is the user's decision to make and their file to own.
 */
export function runTelemetry(args: Args): number {
  const port = flagInt(args, 'otlp-port', DEFAULT_OTLP_PORT)

  console.log('Claude Code can push token and cost metrics here as they happen.')
  console.log('It is off by default. To turn it on, add these to your shell profile:')
  console.log('')
  console.log('  export CLAUDE_CODE_ENABLE_TELEMETRY=1')
  console.log('  export OTEL_METRICS_EXPORTER=otlp')
  console.log('  export OTEL_EXPORTER_OTLP_PROTOCOL=http/json')
  console.log(`  export OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:${port}`)
  console.log('  export OTEL_METRIC_EXPORT_INTERVAL=10000   # optional: 10s instead of 60s')
  console.log('')
  console.log('Then start the service with the receiver enabled (or `tikr start`, which does')
  console.log('this on its own when Grok is installed):')
  console.log('')
  console.log('  tikr stop')
  console.log(`  tikr start --otlp${port === DEFAULT_OTLP_PORT ? '' : ` --otlp-port ${port}`}`)
  console.log('')
  console.log('Restart Claude Code afterwards so it picks up the environment.')
  console.log('')
  console.log('What this adds over reading transcripts:')
  console.log("  - Claude Code's own cost figure, instead of an estimate from list rates")
  console.log('  - a main / subagent / auxiliary breakdown')
  console.log('  - push delivery, so numbers move without waiting for a file write')
  console.log('')
  console.log('What it does not change: transcripts stay the system of record, and the two are')
  console.log('reported separately rather than added together, because they count the same tokens.')
  console.log('')
  console.log(
    `The receiver binds to 127.0.0.1:${port} only, so nothing off this machine can reach it.`,
  )
  console.log('')
  console.log('Grok CLI does not write per-turn tokens to ~/.grok session files.')
  console.log('`tikr start` writes the [telemetry] keys in ~/.grok/config.toml and turns the')
  console.log('receiver on when Grok is installed. Restart Grok afterwards. Usage lands in')
  console.log('`tikr stats` as grok/<model>. Old sessions cannot be backfilled.')
  console.log('')
  console.log('To do the same by hand instead:')
  console.log('')
  console.log('  export GROK_EXTERNAL_OTEL=1')
  console.log('  export OTEL_LOGS_EXPORTER=otlp')
  console.log('  export OTEL_METRICS_EXPORTER=none')
  console.log('  export OTEL_EXPORTER_OTLP_PROTOCOL=http/protobuf')
  console.log(`  export OTEL_EXPORTER_OTLP_ENDPOINT=http://127.0.0.1:${port}`)
  return 0
}
