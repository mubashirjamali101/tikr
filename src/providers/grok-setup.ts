import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { tomlTable, upsertTomlTable } from '../util/toml.js'

export function grokHome(): string {
  const override = process.env.GROK_HOME
  return override && override.length > 0 ? override : join(homedir(), '.grok')
}

const TABLE = 'telemetry'

function configPath(): string {
  return join(grokHome(), 'config.toml')
}

function parseEndpoint(endpoint: string): URL | null {
  try {
    return new URL(endpoint)
  } catch {
    return null
  }
}

function loopbackHost(endpoint: string): boolean {
  const url = parseEndpoint(endpoint)
  if (url === null) return false
  return url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
}

function ourEndpoint(endpoint: string, port: number): boolean {
  const url = parseEndpoint(endpoint)
  if (url === null || !loopbackHost(endpoint)) return false
  const parsed = url.port === '' ? 80 : Number(url.port)
  return parsed === port
}

/**
 * Point Grok's external OTEL stream at this machine's tikr receiver.
 *
 * Grok session files have no token counts; this is the only way to track it. Existing `[telemetry]`
 * keys that are not ours (events_url, mixpanel, content gates) are left alone. A collector that is
 * already pointed somewhere other than loopback is not stolen.
 */
export function setupGrok(options: { otlpPort: number }): string {
  const path = configPath()
  const raw = existsSync(path) ? readFileSync(path, 'utf8') : ''
  const current = tomlTable(raw, TABLE)
  const endpoint = current.otel_endpoint
  if (endpoint !== undefined && endpoint.length > 0 && !loopbackHost(endpoint)) {
    return `left existing OTEL endpoint in place (${endpoint})`
  }

  const values: Record<string, string> = {
    otel_enabled: 'true',
    otel_metrics_exporter: '"none"',
    otel_logs_exporter: '"otlp"',
    otel_endpoint: `"http://127.0.0.1:${options.otlpPort}"`,
    otel_protocol: '"http/protobuf"',
  }
  if (current.otel_log_user_prompts === undefined) values.otel_log_user_prompts = 'false'
  if (current.otel_log_tool_details === undefined) values.otel_log_tool_details = 'false'

  const already =
    current.otel_enabled === 'true' &&
    current.otel_logs_exporter === 'otlp' &&
    (endpoint === undefined || ourEndpoint(endpoint, options.otlpPort))

  const next = upsertTomlTable(raw, TABLE, values)
  if (next !== raw) {
    mkdirSync(grokHome(), { recursive: true })
    writeFileSync(path, next, 'utf8')
  }
  return already
    ? `already pushing usage to 127.0.0.1:${options.otlpPort}`
    : `configured ${path} to push usage here (restart Grok to pick this up)`
}
