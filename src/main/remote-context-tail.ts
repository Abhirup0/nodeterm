// Remote counterpart of context-tail.ts: tails a Claude transcript .jsonl that lives on a
// REMOTE host (read over the project's ControlMaster via an injected RemoteFile) and pushes
// the IDENTICAL ContextWindowUsage IPC the local tail does — the renderer can't tell remote
// from local. Reuses the pure parser (parseLatestUsage) + model-window resolution from the
// local tail; differs only in being async (the read is an ssh round-trip), so it async-polls
// with a per-session in-flight `reading` flag that skips a tick instead of overlapping reads.
import { type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import type { ContextWindowUsage } from '../shared/types'
import { cachedWindowFor, resolveModelWindow } from './model-window'
import { parseLatestUsage } from './context-tail'
import type { RemoteFile, RemoteFileRef } from './remote-ssh/remote-file'

const POLL_MS = 1000
// Cap the first read like the local tail: a resumed transcript can be many MB. Only the LATEST
// assistant usage matters, so a tail of the file is enough. Defined locally (not imported) so
// context-tail.ts stays untouched; value mirrors its INITIAL_READ_CAP.
const INITIAL_READ_CAP = 1024 * 1024 // 1 MB

interface Tracked {
  ref: RemoteFileRef
  offset: number
  used: number
  window: number
  model: string | null
  // In-flight guard: a slow ssh read must not overlap with the next tick.
  reading: boolean
  // Last pushed snapshot — a push fires only when one of these changes.
  lastUsed: number
  lastModel: string | null
  lastWindow: number
}

export interface RemoteContextTail {
  track(sessionId: string | undefined, ref: RemoteFileRef | undefined): void
  untrack(sessionId: string | undefined): void
  /** The transcript path currently tracked for a session, if any. */
  pathFor(sessionId: string | undefined): string | undefined
}

export function createRemoteContextTail(win: BrowserWindow, remoteFile: RemoteFile): RemoteContextTail {
  const sessions = new Map<string, Tracked>()
  let timer: ReturnType<typeof setInterval> | null = null

  const push = (sessionId: string, t: Tracked): void => {
    if (win.isDestroyed()) return
    const usedPercent = Math.min(100, Math.max(0, (t.used / t.window) * 100))
    const payload: ContextWindowUsage = {
      sessionId,
      usedTokens: t.used,
      windowTokens: t.window,
      usedPercent,
      model: t.model,
      updatedAt: Date.now()
    }
    win.webContents.send(IPC.contextUpdate, payload)
  }

  // One async read+reconcile pass for a session. Fail-open: RemoteFile already returns empty on
  // error, so a failed read keeps the last value. The `reading` flag skips overlapping ticks.
  const read = async (sessionId: string, t: Tracked): Promise<void> => {
    if (t.reading) return
    t.reading = true
    try {
      if (t.offset === 0) {
        // First read: grab the tail of the (possibly huge) file in one shot. We can't stat the
        // remote size, so advance the offset by the bytes we actually received.
        const text = await remoteFile.readTail(t.ref, INITIAL_READ_CAP)
        t.offset = Buffer.byteLength(text)
        const latest = parseLatestUsage(text)
        if (latest) {
          t.used = latest.used
          t.model = latest.model ?? t.model
        }
      } else {
        const { text, newOffset } = await remoteFile.readFrom(t.ref, t.offset)
        t.offset = newOffset
        if (text) {
          const latest = parseLatestUsage(text)
          if (latest) {
            t.used = latest.used
            t.model = latest.model ?? t.model
          }
        }
      }
    } finally {
      t.reading = false
    }

    // Reconcile the window every pass, same resolution as the local tail.
    if (t.model) void resolveModelWindow(t.model)
    const window = cachedWindowFor(t.model)

    if (t.used > 0 && (t.used !== t.lastUsed || t.model !== t.lastModel || window !== t.lastWindow)) {
      t.window = window
      push(sessionId, t)
      t.lastUsed = t.used
      t.lastModel = t.model
      t.lastWindow = window
    }
  }

  const tick = (): void => {
    for (const [sessionId, t] of sessions) void read(sessionId, t)
    if (!sessions.size && timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    track(sessionId, ref) {
      if (!sessionId || !ref) return
      const existing = sessions.get(sessionId)
      if (existing) {
        if (existing.ref.path !== ref.path) {
          existing.ref = ref
          existing.offset = 0
        }
        return
      }
      const t: Tracked = {
        ref,
        offset: 0,
        used: 0,
        window: 0,
        model: null,
        reading: false,
        lastUsed: 0,
        lastModel: null,
        lastWindow: 0
      }
      sessions.set(sessionId, t)
      void read(sessionId, t) // immediate first value (resumed sessions already have content)
      if (!timer) timer = setInterval(tick, POLL_MS)
    },
    untrack(sessionId) {
      if (!sessionId) return
      sessions.delete(sessionId)
      if (!sessions.size && timer) {
        clearInterval(timer)
        timer = null
      }
    },
    pathFor(sessionId) {
      if (!sessionId) return undefined
      return sessions.get(sessionId)?.ref.path
    }
  }
}
