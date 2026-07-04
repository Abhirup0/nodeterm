// Computes each Claude session's context-window fill by tailing its transcript .jsonl and
// reading the LATEST assistant message's token usage. Read-only and local; mirrors the
// offset-based read + shared-interval pattern of subagent-tail.ts. Pushed to the renderer
// as ContextWindowUsage keyed by sessionId.
import fs from 'fs'
import { type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import type { ContextWindowUsage } from '../shared/types'
import { cachedWindowFor, resolveModelWindow } from './model-window'
import { splitCompleteLines } from './subagent-tail'

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

/**
 * A completed async subagent, announced back to the parent session as a queued
 * `<task-notification>` prompt (a `queue-operation` transcript line). Carries the spawning
 * tool_use_id, so it's the end signal the async launch's PostToolUse never was.
 */
export interface TaskNotification {
  toolUseId: string
  status?: string
  summary?: string
  result?: string
}

const tag = (content: string, name: string): string | undefined => {
  const m = content.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))
  return m ? m[1].trim() : undefined
}

/** Scan transcript lines for queued <task-notification>s. Pure. */
export function parseTaskNotifications(text: string): TaskNotification[] {
  const out: TaskNotification[] = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    // Cheap pre-filter; the attachment echo of the same notification is skipped by the
    // type check below so each completion fires exactly once.
    if (!s || !s.includes('task-notification') || !s.includes('queue-operation')) continue
    let o: { type?: string; content?: unknown }
    try {
      o = JSON.parse(s)
    } catch {
      continue
    }
    if (o.type !== 'queue-operation' || typeof o.content !== 'string') continue
    if (!o.content.includes('<task-notification>')) continue
    const toolUseId = tag(o.content, 'tool-use-id')
    if (!toolUseId) continue
    out.push({
      toolUseId,
      status: tag(o.content, 'status'),
      summary: tag(o.content, 'summary'),
      // <result> holds the agent's full final text — match greedily to its LAST closing tag.
      result: o.content.match(/<result>([\s\S]*)<\/result>/)?.[1]?.trim()
    })
  }
  return out
}

export interface ContextTailOptions {
  /** Fired when a tracked session's transcript announces a completed async subagent. */
  onTaskNotification?: (sessionId: string, n: TaskNotification) => void
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
  /** An async read is in flight — the next tick skips this session instead of double-reading. */
  reading: boolean
  /**
   * Bytes past the last newline of the previous read — a line caught mid-write, held back and
   * prepended to the next read (see subagent-tail.ts). Without it a torn <task-notification>
   * line would be lost and its subagent card stuck on working forever. Reset on offset jumps.
   */
  carry: Buffer | null
}

export interface ContextTail {
  track(sessionId: string | undefined, transcriptPath: string | undefined): void
  untrack(sessionId: string | undefined): void
  /** The transcript path currently tracked for a session, if any. */
  pathFor(sessionId: string | undefined): string | undefined
}

export function createContextTail(win: BrowserWindow, opts?: ContextTailOptions): ContextTail {
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
  // Async fs throughout: this runs every second per tracked session, and sync syscalls here
  // sat on the same main thread that services all PTY streaming and IPC.
  const read = async (sessionId: string, t: Tracked): Promise<void> => {
    if (t.reading) return
    t.reading = true
    try {
      let size = -1
      try {
        size = (await fs.promises.stat(t.path)).size
      } catch {
        // file not created yet / unreadable — skip the byte read, still reconcile below
      }
      if (size >= 0) {
        const before = t.offset
        if (size < t.offset) t.offset = 0 // truncated/rotated → re-read from start
        // First read of a large transcript: skip to the last INITIAL_READ_CAP bytes.
        if (t.offset === 0 && size > INITIAL_READ_CAP) t.offset = size - INITIAL_READ_CAP
        // Cap deltas too: a huge append burst (resume/compact rewriting MBs between ticks)
        // shouldn't allocate it all — only the LATEST usage matters, so jump to the tail.
        if (size - t.offset > INITIAL_READ_CAP) t.offset = size - INITIAL_READ_CAP
        if (t.offset !== before) t.carry = null // offset jumped — the held bytes don't precede it
        if (size > t.offset) {
          let buf: Buffer
          try {
            const fd = await fs.promises.open(t.path, 'r')
            try {
              buf = Buffer.alloc(size - t.offset)
              await fd.read(buf, 0, buf.length, t.offset)
              t.offset = size
            } finally {
              await fd.close()
            }
          } catch {
            return
          }
          // Usage parses the whole read (carry included) — it tolerates torn lines and the
          // latest value wins, so it must not wait for a newline. Notifications scan
          // COMPLETE lines only, with the torn tail carried into the next read, so a torn
          // <task-notification> is completed later instead of being lost.
          const combined = t.carry?.length ? Buffer.concat([t.carry, buf]) : buf
          const { text: complete, carry } = splitCompleteLines(combined)
          t.carry = carry
          const latest = parseLatestUsage(combined.toString('utf-8'))
          if (latest) {
            t.used = latest.used
            t.model = latest.model ?? t.model
          }
          if (opts?.onTaskNotification) {
            for (const n of parseTaskNotifications(complete)) opts.onTaskNotification(sessionId, n)
          }
        }
      }

      // Reconcile the window every tick: kick off async API resolution once per model
      // (self-gating), and use the best cached/static value now.
      if (t.model) void resolveModelWindow(t.model)
      const win = cachedWindowFor(t.model)

      if (!sessions.has(sessionId)) return // untracked while this async read was in flight
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
    } finally {
      t.reading = false
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
    track(sessionId, transcriptPath) {
      if (!sessionId || !transcriptPath) return
      const existing = sessions.get(sessionId)
      if (existing) {
        if (existing.path !== transcriptPath) {
          existing.path = transcriptPath
          existing.offset = 0
          existing.carry = null
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
        lastWindow: 0,
        reading: false,
        carry: null
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
      return sessions.get(sessionId)?.path
    }
  }
}
