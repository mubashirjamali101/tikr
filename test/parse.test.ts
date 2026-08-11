import { describe, expect, it } from 'vitest'
import { localDay, parseLine } from '../src/core/parse.js'

function entry(overrides: Record<string, unknown> = {}, usage: Record<string, unknown> = {}) {
  return JSON.stringify({
    type: 'assistant',
    timestamp: '2026-08-11T12:49:05.630Z',
    message: {
      id: 'msg_1',
      model: 'claude-opus-5',
      usage: {
        input_tokens: 2,
        output_tokens: 281,
        cache_creation_input_tokens: 19063,
        cache_read_input_tokens: 30640,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 19063 },
        ...usage,
      },
      ...(overrides.message as object),
    },
    ...overrides,
  })
}

describe('parseLine', () => {
  it('extracts usage from a real-shaped assistant entry', () => {
    const record = parseLine(entry())
    expect(record).toMatchObject({
      messageId: 'msg_1',
      model: 'claude-opus-5',
      input: 2,
      output: 281,
      cacheWrite1h: 19063,
      cacheWrite5m: 0,
      cacheRead: 30640,
    })
  })

  it('splits cache writes by TTL, because they are priced differently', () => {
    const record = parseLine(
      entry(
        {},
        { cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 7 } },
      ),
    )
    expect(record?.cacheWrite5m).toBe(100)
    expect(record?.cacheWrite1h).toBe(7)
  })

  it('(bug) charges the cheaper 5m rate when the TTL breakdown is missing', () => {
    // Older entries predate `cache_creation`. Falling back to the 1h bucket would overcharge 60%.
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-11T12:00:00.000Z',
      message: {
        id: 'msg_old',
        model: 'claude-opus-4-8',
        usage: { input_tokens: 1, output_tokens: 2, cache_creation_input_tokens: 500 },
      },
    })
    const record = parseLine(line)
    expect(record?.cacheWrite5m).toBe(500)
    expect(record?.cacheWrite1h).toBe(0)
  })

  it('ignores the synthetic model, which was never billed', () => {
    expect(parseLine(entry({ message: { model: '<synthetic>' } }))).toBeNull()
  })

  it('ignores non-assistant entries and malformed lines', () => {
    expect(parseLine(JSON.stringify({ type: 'user', message: { role: 'user' } }))).toBeNull()
    expect(parseLine('{"type":"assistant","message":{')).toBeNull()
    expect(parseLine('')).toBeNull()
  })

  it('ignores an assistant entry with no usage block', () => {
    const line = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-11T12:00:00.000Z',
      message: { id: 'msg_2', model: 'claude-opus-5' },
    })
    expect(parseLine(line)).toBeNull()
  })

  it('treats negative or non-numeric token counts as zero', () => {
    const record = parseLine(entry({}, { input_tokens: -5, output_tokens: 'nope' }))
    expect(record?.input).toBe(0)
    expect(record?.output).toBe(0)
  })
})

describe('localDay', () => {
  it('returns a YYYY-MM-DD string in local time', () => {
    expect(localDay('2026-08-11T12:00:00.000Z')).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('returns null for an unparseable timestamp', () => {
    expect(localDay('not a date')).toBeNull()
  })
})

describe('version 3 fields', () => {
  function assistant(over: Record<string, unknown> = {}, usageOver: Record<string, unknown> = {}) {
    return JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-11T09:15:00.000Z',
      requestId: 'req_011Cdw',
      message: {
        id: 'msg_1',
        model: 'claude-opus-5',
        usage: {
          input_tokens: 10,
          output_tokens: 100,
          cache_read_input_tokens: 1000,
          cache_creation: { ephemeral_5m_input_tokens: 5, ephemeral_1h_input_tokens: 7 },
          ...usageOver,
        },
      },
      ...over,
    })
  }

  it('reads the request id when present, and tolerates its absence', () => {
    expect(parseLine(assistant())?.requestId).toBe('req_011Cdw')
    expect(parseLine(assistant({ requestId: undefined }))?.requestId).toBeNull()
  })

  it('(bug) reads fast mode from inside usage, where Claude Code actually writes it', () => {
    // First implementation read `message.speed`. The field is `message.usage.speed`, so every fast
    // message was priced at the standard rate - measured on this machine: 41,882 standard, 17 null,
    // 1 fast, all of them under `usage`.
    expect(parseLine(assistant({}, { speed: 'fast' }))?.fast).toBe(true)
    const messageLevel = JSON.stringify({
      type: 'assistant',
      timestamp: '2026-08-11T09:15:00.000Z',
      message: {
        id: 'msg_1',
        model: 'claude-opus-5',
        speed: 'fast',
        usage: { input_tokens: 10, output_tokens: 100 },
      },
    })
    expect(parseLine(messageLevel)?.fast).toBe(false)
  })

  it('treats anything that is not the fast literal as standard', () => {
    expect(parseLine(assistant({}, { speed: 'standard' }))?.fast).toBe(false)
    expect(parseLine(assistant({}, { speed: null }))?.fast).toBe(false)
    expect(parseLine(assistant({}, { speed: 'turbo' }))?.fast).toBe(false)
    expect(parseLine(assistant())?.fast).toBe(false)
  })

  it('derives a local hour that agrees with the local day', () => {
    const record = parseLine(assistant())
    expect(record?.hour.startsWith(record.day)).toBe(true)
    expect(record?.hour).toHaveLength(13)
    expect(record?.at).toBe('2026-08-11T09:15:00.000Z')
  })

  it('counts context as everything the model read, cache included', () => {
    // Cache reads dominate this figure in normal use, so leaving them out would never trip a tier.
    expect(parseLine(assistant())?.contextTokens).toBe(10 + 1000 + 5 + 7)
  })
})
