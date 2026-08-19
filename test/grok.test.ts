import { describe, expect, it } from 'vitest'
import { emptyState } from '../src/core/types.js'
import { applyGrok } from '../src/otlp/apply-grok.js'
import {
  encodeGrokApiRequestProtobuf,
  grokApiRequestJson,
  parseOtlpLogs,
  parseOtlpLogsProtobuf,
} from '../src/otlp/logs.js'
import { grokProvider } from '../src/providers/grok.js'
import { PROVIDERS } from '../src/providers/registry.js'

describe('Grok OTLP logs', () => {
  it('is registered and discovers no session files', () => {
    expect(PROVIDERS.some((p) => p.id === 'grok')).toBe(true)
    expect(grokProvider.discover()).toEqual([])
  })

  it('reads a JSON grok_code.api_request into an observation', () => {
    const observations = parseOtlpLogs(
      grokApiRequestJson({
        model: 'grok-4.6',
        input: 1200,
        output: 80,
        reasoning: 20,
        cacheRead: 400,
      }),
    )
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      model: 'grok-4.6',
      countMode: 'per-growth',
      totals: { input: 1200, output: 100, cacheRead: 400 },
    })
  })

  it('reads the same event from OTLP protobuf', () => {
    const buf = encodeGrokApiRequestProtobuf({
      model: 'grok-4.6',
      input: 1200,
      output: 80,
      reasoning: 20,
      cacheRead: 400,
      sequence: '42',
    })
    const observations = parseOtlpLogsProtobuf(buf)
    expect(observations).toHaveLength(1)
    expect(observations[0]).toMatchObject({
      model: 'grok-4.6',
      series: '42',
      totals: { input: 1200, output: 100, cacheRead: 400 },
    })
  })

  it('ignores other grok events', () => {
    const payload = grokApiRequestJson({ model: 'grok-4.6', input: 1, output: 1 })
    const record = (
      payload as { resourceLogs: { scopeLogs: { logRecords: { eventName: string }[] }[] }[] }
    ).resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!
    record.eventName = 'grok_code.turn_completed'
    expect(parseOtlpLogs(payload)).toEqual([])
  })

  it('folds into the main ledger as grok/<model>', () => {
    const state = emptyState()
    const [observation] = parseOtlpLogs(
      grokApiRequestJson({ model: 'grok-4.6', input: 50, output: 10, sequence: 'a' }),
    )
    expect(observation).toBeDefined()
    expect(applyGrok(state, observation!)).toBe(true)
    expect(state.daily[observation!.day]?.['grok/grok-4.6']).toMatchObject({
      input: 50,
      output: 10,
      messages: 1,
    })
    expect(state.projects.grok?.['grok/grok-4.6']?.input).toBe(50)
  })

  it('does not double-count the same request sequence', () => {
    const state = emptyState()
    const payload = grokApiRequestJson({
      model: 'grok-4.6',
      input: 50,
      output: 10,
      sequence: 'same',
    })
    const [first] = parseOtlpLogs(payload)
    const [second] = parseOtlpLogs(payload)
    applyGrok(state, first!)
    applyGrok(state, second!)
    expect(state.daily[first!.day]?.['grok/grok-4.6']?.input).toBe(50)
    expect(state.daily[first!.day]?.['grok/grok-4.6']?.messages).toBe(1)
  })
})

describe('OTLP receiver accepts Grok protobuf logs', () => {
  it('posts /v1/logs and folds usage', async () => {
    const { startOtlpReceiver } = await import('../src/otlp/receiver.js')
    const seen: number[] = []
    const port = 43100 + Math.floor(Math.random() * 500)
    const server = startOtlpReceiver({
      port,
      onSamples: () => {},
      onGrok: (observations) => {
        seen.push(observations.length)
      },
    })
    await new Promise<void>((resolve, reject) => {
      if (server.listening) resolve()
      else server.once('listening', () => resolve())
      server.once('error', reject)
    })
    const body = encodeGrokApiRequestProtobuf({
      model: 'grok-4.6',
      input: 7,
      output: 3,
      sequence: 'recv',
    })
    const res = await fetch(`http://127.0.0.1:${port}/v1/logs`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-protobuf' },
      body,
    })
    expect(res.status).toBe(200)
    await new Promise((r) => setTimeout(r, 40))
    expect(seen[0]).toBe(1)
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    )
  })
})
