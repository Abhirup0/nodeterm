import { describe, it, expect } from 'vitest'
import { createSnapshotReassembler } from '../../src/main/remote/snapshot'
import { OP, decodeFrame, encodeFrame } from '../../src/main/remote/framing'

const enc = new TextEncoder()

// Build the three-stage snapshot wire sequence for one stream: Start, N chunks, End.
function snapshotFrames(streamId: number, chunks: string[]): Uint8Array[] {
  let seq = 0
  const frames: Uint8Array[] = []
  frames.push(encodeFrame(OP.SnapshotStart, streamId, seq++, new Uint8Array(0)))
  for (const c of chunks) frames.push(encodeFrame(OP.SnapshotChunk, streamId, seq++, enc.encode(c)))
  frames.push(encodeFrame(OP.SnapshotEnd, streamId, seq++, new Uint8Array(0)))
  return frames
}

describe('createSnapshotReassembler', () => {
  it('concatenates SnapshotStart→Chunk*→End into the original string and signals ready on End', () => {
    const r = createSnapshotReassembler()
    const frames = snapshotFrames(5, ['hello ', 'world'])

    // Start: opens the buffer, no payload yet, not ready.
    expect(r.accept(decodeFrame(frames[0])!)).toEqual({ done: false })
    // Chunks accumulate, still not ready.
    expect(r.accept(decodeFrame(frames[1])!)).toEqual({ done: false })
    expect(r.accept(decodeFrame(frames[2])!)).toEqual({ done: false })
    // End: ready, with the reassembled text.
    expect(r.accept(decodeFrame(frames[3])!)).toEqual({ done: true, text: 'hello world' })
  })

  it('handles an empty snapshot (Start then End, no chunks)', () => {
    const r = createSnapshotReassembler()
    let seq = 0
    const start = decodeFrame(encodeFrame(OP.SnapshotStart, 1, seq++, new Uint8Array(0)))!
    const end = decodeFrame(encodeFrame(OP.SnapshotEnd, 1, seq++, new Uint8Array(0)))!
    expect(r.accept(start)).toEqual({ done: false })
    expect(r.accept(end)).toEqual({ done: true, text: '' })
  })

  it('preserves UTF-8 across chunk boundaries (multi-byte split)', () => {
    const r = createSnapshotReassembler()
    // "é" is 0xC3 0xA9 — split the two bytes across two chunks to prove byte-level reassembly.
    const full = enc.encode('café')
    const a = full.slice(0, 4) // "caf" + first byte of é
    const b = full.slice(4) // second byte of é
    let seq = 0
    r.accept(decodeFrame(encodeFrame(OP.SnapshotStart, 2, seq++, new Uint8Array(0)))!)
    r.accept(decodeFrame(encodeFrame(OP.SnapshotChunk, 2, seq++, a))!)
    r.accept(decodeFrame(encodeFrame(OP.SnapshotChunk, 2, seq++, b))!)
    const res = r.accept(decodeFrame(encodeFrame(OP.SnapshotEnd, 2, seq++, new Uint8Array(0)))!)
    expect(res).toEqual({ done: true, text: 'café' })
  })

  it('a fresh Start resets a partial buffer (no leak between snapshots)', () => {
    const r = createSnapshotReassembler()
    let seq = 0
    r.accept(decodeFrame(encodeFrame(OP.SnapshotStart, 3, seq++, new Uint8Array(0)))!)
    r.accept(decodeFrame(encodeFrame(OP.SnapshotChunk, 3, seq++, enc.encode('stale')))!)
    // New Start discards the stale partial buffer.
    r.accept(decodeFrame(encodeFrame(OP.SnapshotStart, 3, seq++, new Uint8Array(0)))!)
    r.accept(decodeFrame(encodeFrame(OP.SnapshotChunk, 3, seq++, enc.encode('fresh')))!)
    const res = r.accept(decodeFrame(encodeFrame(OP.SnapshotEnd, 3, seq++, new Uint8Array(0)))!)
    expect(res).toEqual({ done: true, text: 'fresh' })
  })
})
