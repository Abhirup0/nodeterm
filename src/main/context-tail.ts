// Computes each Claude session's context-window fill by tailing its transcript .jsonl and
// reading the LATEST assistant message's token usage. Read-only and local; mirrors the
// offset-based read + shared-interval pattern of subagent-tail.ts. Pushed to the renderer
// as ContextWindowUsage keyed by sessionId.
import fs from 'fs'
import { type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import type { ContextWindowUsage } from '../shared/types'

const DEFAULT_WINDOW = 200_000
const LARGE_WINDOW = 1_000_000
const POLL_MS = 1000

interface Tracked {
  path: string
  offset: number
  used: number
  window: number
  model: string | null
}

function windowForModel(model: string | null): number {
  return model && /1m/i.test(model) ? LARGE_WINDOW : DEFAULT_WINDOW
}

export interface ContextTail {
  track(sessionId: string | undefined, transcriptPath: string | undefined): void
  untrack(sessionId: string | undefined): void
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

  // Read appended bytes from t.offset; update used/window/model from the latest assistant
  // usage seen in the new lines; push once if anything changed.
  const read = (sessionId: string, t: Tracked): void => {
    let size: number
    try {
      size = fs.statSync(t.path).size
    } catch {
      return // file not created yet / unreadable — try again next tick
    }
    if (size < t.offset) t.offset = 0 // truncated/rotated → re-read from start
    if (size === t.offset) return
    let chunk = ''
    try {
      const fd = fs.openSync(t.path, 'r')
      const buf = Buffer.alloc(size - t.offset)
      fs.readSync(fd, buf, 0, buf.length, t.offset)
      fs.closeSync(fd)
      chunk = buf.toString('utf-8')
    } catch {
      return
    }
    t.offset = size
    let changed = false
    for (const line of chunk.split('\n')) {
      const s = line.trim()
      if (!s) continue
      let o: { type?: string; message?: { model?: string; usage?: Record<string, number> } }
      try {
        o = JSON.parse(s)
      } catch {
        continue // partial/garbled line
      }
      if (o.type !== 'assistant' || !o.message?.usage) continue
      const u = o.message.usage
      const used =
        (u.input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0)
      if (used <= 0) continue
      t.used = used
      t.model = o.message.model ?? t.model
      t.window = windowForModel(t.model)
      changed = true
    }
    if (changed) push(sessionId, t)
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
        window: DEFAULT_WINDOW,
        model: null
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
    }
  }
}
