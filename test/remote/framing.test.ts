import { describe, it, expect } from 'vitest'
import { encodeFrame, decodeFrame, OP } from '../../src/main/remote/framing'

describe('framing', () => {
  it('round-trips op, streamId, seq, payload', () => {
    const payload = new TextEncoder().encode('terminal output')
    const buf = encodeFrame(OP.Output, 42, 7, payload)
    const f = decodeFrame(buf)
    expect(f).not.toBeNull()
    expect(f!.op).toEqual(OP.Output)
    expect(f!.streamId).toEqual(42)
    expect(f!.seq).toEqual(7)
    expect(Buffer.from(f!.payload).toString('utf8')).toEqual('terminal output')
  })

  it('round-trips a 64-bit seq beyond 2^32', () => {
    const seq = 0x1_0000_0005 // > 2^32
    const buf = encodeFrame(OP.Input, 1, seq, new Uint8Array([1, 2, 3]))
    const f = decodeFrame(buf)
    expect(f).not.toBeNull()
    expect(f!.seq).toEqual(seq)
  })

  it('round-trips an empty payload', () => {
    const buf = encodeFrame(OP.Subscribe, 9, 0, new Uint8Array())
    const f = decodeFrame(buf)
    expect(f).not.toBeNull()
    expect(f!.op).toEqual(OP.Subscribe)
    expect(f!.payload.length).toEqual(0)
  })

  it('exposes stable wire opcode numbers', () => {
    expect(OP.Output).toEqual(1)
    expect(OP.Input).toEqual(7)
    expect(OP.Resize).toEqual(8)
    expect(OP.Subscribe).toEqual(9)
    expect(OP.Unsubscribe).toEqual(10)
  })

  it('decodeFrame returns null for too-short buffers', () => {
    expect(decodeFrame(new Uint8Array(4))).toBeNull()
  })

  it('decodeFrame returns null for a bad header / unknown opcode', () => {
    const buf = encodeFrame(OP.Output, 1, 1, new Uint8Array())
    const bad = buf.slice()
    bad[0] = 0x00 // corrupt the stream kind byte
    expect(decodeFrame(bad)).toBeNull()
  })
})
