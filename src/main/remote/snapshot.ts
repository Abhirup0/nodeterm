// Snapshot reassembly — the unit-testable core of the terminal "current screen" feature.
//
// When a client attaches to a host's existing tmux session it must paint the CURRENT screen
// before any live output arrives, otherwise the mirrored xterm renders blank (B4's bug). The
// host sends the captured screen as a three-stage sequence on the stream's channel:
//
//   OP.SnapshotStart            — opens the buffer (payload ignored; reserved for a header)
//   OP.SnapshotChunk (0..N)     — payload = a slice of the UTF-8 bytes of the captured screen
//   OP.SnapshotEnd              — closes the buffer; the accumulated bytes are decoded to text
//
// The reassembler accumulates the chunk *bytes* (so a multi-byte UTF-8 codepoint split across a
// chunk boundary survives) and only decodes on End. Pure: no sockets, no Electron.

import { OP, type Frame } from './framing'

const textDecoder = new TextDecoder()

/** Result of feeding one frame: `done:false` while buffering, `done:true` + `text` on End. */
export type SnapshotResult = { done: false } | { done: true; text: string }

export interface SnapshotReassembler {
  /**
   * Feed one decoded frame. Returns `{done:false}` for Start/Chunk (and for unrelated frames),
   * or `{done:true, text}` on End — the reassembled snapshot text, ready to deliver as the
   * session's first `onData`.
   */
  accept(frame: Frame): SnapshotResult
}

export function createSnapshotReassembler(): SnapshotReassembler {
  // Pending chunk byte-slices, concatenated only on End so a multi-byte codepoint split across
  // a chunk boundary is decoded correctly.
  let chunks: Uint8Array[] = []
  let open = false

  return {
    accept(frame) {
      switch (frame.op) {
        case OP.SnapshotStart:
          // A fresh Start discards any partial buffer (no leak between snapshots on one stream).
          chunks = []
          open = true
          return { done: false }
        case OP.SnapshotChunk:
          if (open && frame.payload.length > 0) chunks.push(frame.payload)
          return { done: false }
        case OP.SnapshotEnd: {
          const total = chunks.reduce((n, c) => n + c.length, 0)
          const merged = new Uint8Array(total)
          let offset = 0
          for (const c of chunks) {
            merged.set(c, offset)
            offset += c.length
          }
          chunks = []
          open = false
          return { done: true, text: textDecoder.decode(merged) }
        }
        default:
          return { done: false }
      }
    }
  }
}
