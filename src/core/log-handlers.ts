import { IPC } from '../shared/ipc'
import type { CorePlatform } from './platform'
import type { LogBuffer } from './log-buffer'

/** Coalesce bursts into one push — a build spraying warnings must not become an IPC-per-line. */
export const LOG_PUSH_DEBOUNCE_MS = 200

/**
 * IPC for the debug log panel (issue #78): snapshot/clear request-response plus a ref-counted
 * subscribe → batched `logBatch` broadcasts (the board-log-handlers pattern). Batches flow only
 * while at least one panel is subscribed AND the setting is on — with the panel closed the ring
 * still fills, but nothing crosses the process boundary.
 *
 * Duplicate delivery is possible around the subscribe edge (the panel snapshots, then the first
 * flush may include records the snapshot already carried) — the client dedupes by `seq`, which
 * is monotonic, instead of this layer trying to track per-subscriber positions.
 */
export function registerLogHandlers(
  platform: CorePlatform,
  buffer: LogBuffer,
  enabled: () => boolean
): void {
  let subscribers = 0
  let lastSent = 0
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    timer = null
    if (subscribers <= 0 || !enabled()) return
    const batch = buffer.since(lastSent)
    if (batch.length === 0) return
    lastSent = batch[batch.length - 1].seq
    platform.broadcast(IPC.logBatch, batch)
  }
  const schedule = (): void => {
    if (timer) return
    timer = setTimeout(flush, LOG_PUSH_DEBOUNCE_MS)
    timer.unref?.()
  }

  buffer.onAppend(() => {
    if (subscribers > 0 && enabled()) schedule()
  })

  platform.on(IPC.logSubscribe, () => {
    subscribers++
    // New panel: it snapshots for the fill; start the stream from "now" so the first flush
    // doesn't replay the whole ring (the seq-dedupe on the client makes the overlap harmless).
    if (subscribers === 1) lastSent = buffer.lastSeq()
    schedule()
  })
  platform.on(IPC.logUnsubscribe, () => {
    subscribers = Math.max(0, subscribers - 1)
  })
  platform.handle(IPC.logSnapshot, () => buffer.snapshot())
  platform.on(IPC.logClear, () => buffer.clear())
}
