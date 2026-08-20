/**
 * The output discipline every `ProjectSetupRunner` shares: one capped budget, debounced chunk
 * delivery, exactly one truncation note.
 *
 * Extracted from the local runner when the SSH runner arrived, because the rules here are a
 * CONTRACT the service layer and the UI both depend on ("stdout+stderr interleaved, capped",
 * one event per burst rather than per line) — not an implementation detail either runner is free
 * to drift on. Two copies would drift: the first cap bump or note reword would land in one file
 * and be forgotten in the other, and the UI would silently show two different truncation stories
 * depending on whether the project happened to be local or remote.
 */

/** Combined stdout+stderr budget for one run — the SAME cap `ProjectSetupEvent.chunk` documents
 *  ("stdout+stderr interleaved, capped"). Deliberately one shared budget rather than one per
 *  stream: a script that floods only stderr must not get 1MB total just because stdout stayed
 *  quiet. */
export const SETUP_OUTPUT_CAP = 512 * 1024

/** SIGKILL a run that outlives this — a hung `setupScript` must never wedge the single-flight
 *  slot forever. Test-injectable via each runner's `opts.timeoutMs` so a suite doesn't wait 10
 *  real minutes. */
export const SETUP_TIMEOUT_MS = 10 * 60 * 1000

/** Chunks are batched to `onChunk` at most this often (plus one final flush on exit), matching
 *  the debounce the brief calls for — a script that `echo`s in a tight loop must not turn into
 *  an event per line. */
const FLUSH_DEBOUNCE_MS = 150

const TRUNCATION_NOTE = '\n[output truncated — exceeded 512KB]\n'

export interface SetupOutputStream {
  /** Feed decoded output (either stream). Past the cap this appends the truncation note ONCE and
   *  drops everything after it. */
  append(text: string): void
  /** Deliver whatever is buffered now and cancel the pending debounce — call this exactly once,
   *  from the runner's `finish`, so the tail of a run is never lost to an unfired timer. */
  flush(): void
}

export function createSetupOutputStream(onChunk: (text: string) => void): SetupOutputStream {
  let totalBytes = 0
  let truncated = false
  let pending = ''
  let flushTimer: ReturnType<typeof setTimeout> | null = null

  const flush = (): void => {
    if (flushTimer) {
      clearTimeout(flushTimer)
      flushTimer = null
    }
    if (!pending) return
    const text = pending
    pending = ''
    onChunk(text)
  }

  const scheduleFlush = (): void => {
    if (flushTimer) return
    flushTimer = setTimeout(flush, FLUSH_DEBOUNCE_MS)
    flushTimer.unref?.()
  }

  const append = (text: string): void => {
    if (!text || truncated) return
    const remaining = SETUP_OUTPUT_CAP - totalBytes
    if (remaining <= 0) {
      truncated = true
      pending += TRUNCATION_NOTE
      scheduleFlush()
      return
    }
    const asBytes = Buffer.byteLength(text, 'utf-8')
    if (asBytes <= remaining) {
      pending += text
      totalBytes += asBytes
    } else {
      const cut = Buffer.from(text, 'utf-8').subarray(0, remaining).toString('utf-8')
      pending += cut
      totalBytes += Buffer.byteLength(cut, 'utf-8')
      truncated = true
      pending += TRUNCATION_NOTE
    }
    scheduleFlush()
  }

  return { append, flush }
}
