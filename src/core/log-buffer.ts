import { redactSecrets } from './log-redact'
import type { LogRecord } from '../shared/types'

export type { LogRecord }

/** Ring capacity. Big enough to hold a debugging session, small enough to never matter in RAM
 *  (~2000 × a few hundred bytes). */
export const LOG_BUFFER_CAP = 2000

/** A single line is capped so a runaway payload (a whole file echoed into console) cannot make
 *  the ring one giant entry — the tail is what debugging needs anyway. */
export const LOG_LINE_MAX = 4000

/**
 * The in-memory debug log ring (issue #78). Redaction happens HERE, in push(): nothing
 * unredacted ever exists in the ring, so no later consumer — the panel, a copy-export, a
 * screenshot — can leak a credential the boundary already removed.
 */
export class LogBuffer {
  private entries: LogRecord[] = []
  private seq = 0
  private listeners = new Set<() => void>()

  push(r: { level: LogRecord['level']; tag: string; msg: string }): void {
    const msg = redactSecrets(r.msg.length > LOG_LINE_MAX ? `${r.msg.slice(0, LOG_LINE_MAX)}…` : r.msg)
    this.entries.push({ seq: ++this.seq, ts: Date.now(), level: r.level, tag: r.tag, msg })
    if (this.entries.length > LOG_BUFFER_CAP) {
      this.entries.splice(0, this.entries.length - LOG_BUFFER_CAP)
    }
    for (const cb of this.listeners) {
      try {
        cb()
      } catch {
        /* a broken listener must not break logging */
      }
    }
  }

  /** Everything currently in the ring (panel open → initial fill). */
  snapshot(): LogRecord[] {
    return [...this.entries]
  }

  /** Records newer than `seq` (batched push to an already-filled subscriber). */
  since(seq: number): LogRecord[] {
    // The ring is sorted by seq; find the first newer record.
    const idx = this.entries.findIndex((e) => e.seq > seq)
    return idx === -1 ? [] : this.entries.slice(idx)
  }

  lastSeq(): number {
    return this.seq
  }

  clear(): void {
    this.entries = []
  }

  /** Notify on every push — the handlers layer debounces, so this stays a plain sync fan-out. */
  onAppend(cb: () => void): () => void {
    this.listeners.add(cb)
    return () => this.listeners.delete(cb)
  }
}
