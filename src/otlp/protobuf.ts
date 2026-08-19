/**
 * Tiny protobuf reader/writer for the OTLP subset Grok actually sends.
 *
 * Grok's external stream is `http/protobuf` (or gRPC, which we do not speak). Claude Code speaks
 * `http/json`. Keeping a local decoder means the receiver stays dependency-free while still
 * reading Grok's payloads. Only the fields we need are decoded; unknown tags are skipped.
 */

export const WIRE_VARINT = 0
export const WIRE_FIXED64 = 1
export const WIRE_LEN = 2
export const WIRE_FIXED32 = 5

export type Field = {
  n: number
  wire: number
  varint: bigint
  bytes: Buffer
}

export function decodeFields(buf: Buffer, start = 0, end = buf.length): Field[] {
  const out: Field[] = []
  let i = start
  while (i < end) {
    const tag = readVarint(buf, i)
    i = tag.next
    const n = Number(tag.value >> 3n)
    const wire = Number(tag.value & 7n)
    if (wire === WIRE_VARINT) {
      const v = readVarint(buf, i)
      i = v.next
      out.push({ n, wire, varint: v.value, bytes: Buffer.alloc(0) })
    } else if (wire === WIRE_FIXED64) {
      if (i + 8 > end) break
      out.push({ n, wire, varint: 0n, bytes: buf.subarray(i, i + 8) })
      i += 8
    } else if (wire === WIRE_LEN) {
      const len = readVarint(buf, i)
      i = len.next
      const size = Number(len.value)
      if (i + size > end) break
      out.push({ n, wire, varint: 0n, bytes: buf.subarray(i, i + size) })
      i += size
    } else if (wire === WIRE_FIXED32) {
      if (i + 4 > end) break
      out.push({ n, wire, varint: 0n, bytes: buf.subarray(i, i + 4) })
      i += 4
    } else {
      break
    }
  }
  return out
}

function readVarint(buf: Buffer, start: number): { value: bigint; next: number } {
  let value = 0n
  let shift = 0n
  let i = start
  while (i < buf.length) {
    const b = buf[i]!
    i += 1
    value |= BigInt(b & 0x7f) << shift
    if ((b & 0x80) === 0) break
    shift += 7n
  }
  return { value, next: i }
}

function writeVarint(value: number | bigint): Buffer {
  let v = typeof value === 'bigint' ? value : BigInt(value)
  const parts: number[] = []
  while (v >= 0x80n) {
    parts.push(Number(v & 0x7fn) | 0x80)
    v >>= 7n
  }
  parts.push(Number(v))
  return Buffer.from(parts)
}

function tag(field: number, wire: number): Buffer {
  return writeVarint((field << 3) | wire)
}

export function encodeVarintField(field: number, value: number | bigint): Buffer {
  return Buffer.concat([tag(field, WIRE_VARINT), writeVarint(value)])
}

export function encodeLenField(field: number, payload: Buffer): Buffer {
  return Buffer.concat([tag(field, WIRE_LEN), writeVarint(payload.length), payload])
}

export function encodeFixed64Field(field: number, value: bigint): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64LE(value)
  return Buffer.concat([tag(field, WIRE_FIXED64), buf])
}

export function encodeSFixed64Field(field: number, value: bigint): Buffer {
  const buf = Buffer.alloc(8)
  buf.writeBigInt64LE(value)
  return Buffer.concat([tag(field, WIRE_FIXED64), buf])
}

export function encodeStringField(field: number, value: string): Buffer {
  return encodeLenField(field, Buffer.from(value, 'utf8'))
}

export function stringValue(fields: Field[], n: number): string | null {
  const hit = fields.find((f) => f.n === n && f.wire === WIRE_LEN)
  return hit ? hit.bytes.toString('utf8') : null
}

export function varintValue(fields: Field[], n: number): bigint | null {
  const hit = fields.find((f) => f.n === n && f.wire === WIRE_VARINT)
  return hit ? hit.varint : null
}

export function fixed64Value(fields: Field[], n: number): bigint | null {
  const hit = fields.find((f) => f.n === n && f.wire === WIRE_FIXED64 && f.bytes.length === 8)
  return hit ? hit.bytes.readBigUInt64LE(0) : null
}

export function sfixed64Value(fields: Field[], n: number): bigint | null {
  const hit = fields.find((f) => f.n === n && f.wire === WIRE_FIXED64 && f.bytes.length === 8)
  return hit ? hit.bytes.readBigInt64LE(0) : null
}

export function repeated(fields: Field[], n: number): Field[] {
  return fields.filter((f) => f.n === n)
}

/** OTLP AnyValue / KeyValue helpers. */
export function encodeAnyValue(value: string | number | bigint): Buffer {
  if (typeof value === 'string') return encodeStringField(1, value)
  if (typeof value === 'number' && !Number.isInteger(value)) {
    const buf = Buffer.alloc(8)
    buf.writeDoubleLE(value)
    return Buffer.concat([tag(4, WIRE_FIXED64), buf])
  }
  return encodeVarintField(3, typeof value === 'bigint' ? value : BigInt(value))
}

export function encodeKeyValue(key: string, value: string | number | bigint): Buffer {
  return Buffer.concat([encodeStringField(1, key), encodeLenField(2, encodeAnyValue(value))])
}

export function decodeAnyValue(buf: Buffer): string | number | bigint | null {
  const fields = decodeFields(buf)
  const s = stringValue(fields, 1)
  if (s !== null) return s
  const i = varintValue(fields, 3)
  if (i !== null) return i
  const d = fields.find((f) => f.n === 4 && f.wire === WIRE_FIXED64)
  if (d && d.bytes.length === 8) return d.bytes.readDoubleLE(0)
  const b = varintValue(fields, 2)
  if (b !== null) return b === 1n ? 1 : 0
  return null
}

export function decodeKeyValues(fields: Field[], n: number): Record<string, string> {
  const out: Record<string, string> = {}
  for (const item of repeated(fields, n)) {
    const inner = decodeFields(item.bytes)
    const key = stringValue(inner, 1)
    const valueField = inner.find((f) => f.n === 2 && f.wire === WIRE_LEN)
    if (key === null || valueField === undefined) continue
    const value = decodeAnyValue(valueField.bytes)
    if (value !== null) out[key] = String(value)
  }
  return out
}
