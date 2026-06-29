// Computes each Claude session's context-window fill by tailing its transcript .jsonl and
// reading the LATEST assistant message's token usage. Read-only and local; mirrors the
// offset-based read + shared-interval pattern of subagent-tail.ts. Pushed to the renderer
// as ContextWindowUsage keyed by sessionId.
import fs from 'fs'
import { type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import type { ContextWindowUsage } from '../shared/types'
import { cachedWindowFor, resolveModelWindow } from './model-window'

const POLL_MS = 1000
// Cap the initial read: a resumed Claude transcript can be many MB, and reading the whole file
// synchronously on the main thread (Buffer.alloc(size) + JSON.parse per line) stalls all IPC.
// Only the LATEST assistant usage matters, so a tail of the file is enough; the partial first
// line is dropped naturally by the JSON.parse guard.
const INITIAL_READ_CAP = 1024 * 1024 // 1 MB

/** Scan transcript text for the LATEST assistant message's token usage + model. Pure. */
export function parseLatestUsage(text: string): { used: number; model: string | null } | null {
  let found = false
  let usedTokens = 0
  let model: string | null = null
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let o: { type?: string; message?: { model?: string; usage?: Record<string, number> } }
    try {
      o = JSON.parse(s)
    } catch {
      continue
    }
    if (o.type !== 'assistant' || !o.message?.usage) continue
    const u = o.message.usage
    const used =
      (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
    if (used <= 0) continue
    found = true
    usedTokens = used
    model = o.message.model ?? model // carry the prior model forward when this line omits it
  }
  return found ? { used: usedTokens, model } : null
}

interface Tracked {
  path: string
  offset: number
  used: number
  window: number
  model: string | null
  // Last pushed snapshot — a push fires only when one of these changes.
  lastUsed: number
  lastModel: string | null
  lastWindow: number
}

export interface ContextTail {
  track(sessionId: string | undefined, transcriptPath: string | undefined): void
  untrack(sessionId: string | undefined): void
  /** The transcript path currently tracked for a session, if any. */
  pathFor(sessionId: string | undefined): string | undefined
}

export function createContextTail(win: BrowserWindow): ContextTail {
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

  // Read newly-appended transcript bytes (if any), reconcile the window from the model
  // resolver, and push when the used tokens / model / window changed since the last push.
  const read = (sessionId: string, t: Tracked): void => {
    let size = -1
    try {
      size = fs.statSync(t.path).size
    } catch {
      // file not created yet / unreadable — skip the byte read, still reconcile below
    }
    if (size >= 0) {
      if (size < t.offset) t.offset = 0 // truncated/rotated → re-read from start
      // First read of a large transcript: skip to the last INITIAL_READ_CAP bytes.
      if (t.offset === 0 && size > INITIAL_READ_CAP) t.offset = size - INITIAL_READ_CAP
      if (size > t.offset) {
        let chunk = ''
        try {
          const fd = fs.openSync(t.path, 'r')
          const buf = Buffer.alloc(size - t.offset)
          fs.readSync(fd, buf, 0, buf.length, t.offset)
          fs.closeSync(fd)
          chunk = buf.toString('utf-8')
          t.offset = size
        } catch {
          return
        }
        const latest = parseLatestUsage(chunk)
        if (latest) {
          t.used = latest.used
          t.model = latest.model ?? t.model
        }
      }
    }

    // Reconcile the window every tick: kick off async API resolution once per model
    // (self-gating), and use the best cached/static value now.
    if (t.model) void resolveModelWindow(t.model)
    const win = cachedWindowFor(t.model)

    if (
      t.used > 0 &&
      (t.used !== t.lastUsed || t.model !== t.lastModel || win !== t.lastWindow)
    ) {
      t.window = win
      push(sessionId, t)
      t.lastUsed = t.used
      t.lastModel = t.model
      t.lastWindow = win
    }
  }

  const tick = (): void => {
    for (const [sessionId, t] of sessions) read(sessionId, t)
    if (!sessions.size && timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    track(sessionId, transcriptPath) {
      if (!sessionId || !transcriptPath) return
      const existing = sessions.get(sessionId)
      if (existing) {
        if (existing.path !== transcriptPath) {
          existing.path = transcriptPath
          existing.offset = 0
        }
        return
      }
      const t: Tracked = {
        path: transcriptPath,
        offset: 0,
        used: 0,
        window: 0,
        model: null,
        lastUsed: 0,
        lastModel: null,
        lastWindow: 0
      }
      sessions.set(sessionId, t)
      read(sessionId, t) // immediate first value (resumed sessions already have content)
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
      return sessions.get(sessionId)?.path
    }
  }
}
