// Streams a subagent's live transcript to the renderer while it runs.
//
// Each subagent Claude spawns gets its own transcript at
//   <parent transcript dir>/<sessionId>/subagents/agent-<agentId>.jsonl
// plus an agent-<agentId>.meta.json that carries the spawning tool_use_id. We resolve the
// file by matching that toolUseId, then tail it (offset-based) and forward formatted lines.
// All read-only — if Claude changes the format we just stream less (no crash).
import fs from 'fs'
import path from 'path'
import { type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'

interface Tracked {
  dir: string
  file: string | null
  offset: number
}

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (c && typeof c === 'object' && 'text' in c ? String((c as { text: unknown }).text ?? '') : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

// Render one transcript line into readable text. Includes everything substantive
// (assistant text + tool calls, user/tool results); skips pure-metadata lines.
function formatLine(line: string): string {
  let o: { type?: string; message?: { content?: unknown } }
  try {
    o = JSON.parse(line)
  } catch {
    return ''
  }
  const content = o.message?.content
  if (o.type === 'assistant' && Array.isArray(content)) {
    return content
      .map((c: { type?: string; text?: string; name?: string; input?: unknown }) => {
        if (c.type === 'text') return c.text ?? ''
        if (c.type === 'tool_use') {
          const input = c.input ? JSON.stringify(c.input) : ''
          return `→ ${c.name}${input ? ` ${input.slice(0, 120)}` : ''}`
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  if (o.type === 'user' && Array.isArray(content)) {
    return content
      .map((c: { type?: string; text?: string; content?: unknown }) => {
        if (c.type === 'text') return c.text ?? ''
        if (c.type === 'tool_result') {
          const r = textOf(c.content)
          return r ? `⮑ ${r.slice(0, 400)}` : ''
        }
        return ''
      })
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

export interface SubagentTail {
  track(toolUseId: string, transcriptPath: string | undefined): void
  finish(toolUseId: string): void
}

export function createSubagentTail(win: BrowserWindow): SubagentTail {
  const tracked = new Map<string, Tracked>()
  let timer: ReturnType<typeof setInterval> | null = null

  const send = (toolUseId: string, chunk: string) => {
    if (chunk && !win.isDestroyed()) win.webContents.send(IPC.claudeSubagentActivity, { toolUseId, chunk })
  }

  const readOne = (toolUseId: string, e: Tracked) => {
    try {
      if (!e.file) {
        let metas: string[]
        try {
          metas = fs.readdirSync(e.dir)
        } catch {
          return // dir not created yet
        }
        for (const m of metas) {
          if (!m.endsWith('.meta.json')) continue
          try {
            const meta = JSON.parse(fs.readFileSync(path.join(e.dir, m), 'utf-8'))
            if (meta.toolUseId === toolUseId) {
              e.file = path.join(e.dir, m.replace(/\.meta\.json$/, '.jsonl'))
              break
            }
          } catch {
            // ignore unparseable meta
          }
        }
        if (!e.file) return
      }
      const size = fs.statSync(e.file).size
      if (size <= e.offset) return
      const buf = Buffer.alloc(size - e.offset)
      const fd = fs.openSync(e.file, 'r')
      fs.readSync(fd, buf, 0, buf.length, e.offset)
      fs.closeSync(fd)
      e.offset = size
      const out = buf
        .toString('utf-8')
        .split('\n')
        .filter(Boolean)
        .map(formatLine)
        .filter(Boolean)
        .join('\n')
      if (out) send(toolUseId, out + '\n')
    } catch {
      // file may not exist yet / transient read error
    }
  }

  const tick = () => {
    for (const [toolUseId, e] of tracked) readOne(toolUseId, e)
    if (!tracked.size && timer) {
      clearInterval(timer)
      timer = null
    }
  }

  return {
    track(toolUseId, transcriptPath) {
      if (!transcriptPath || tracked.has(toolUseId)) return
      const dir = path.join(transcriptPath.replace(/\.jsonl$/, ''), 'subagents')
      tracked.set(toolUseId, { dir, file: null, offset: 0 })
      if (!timer) timer = setInterval(tick, 400) // only runs while subagents are active
    },
    finish(toolUseId) {
      const e = tracked.get(toolUseId)
      if (e) readOne(toolUseId, e) // final flush
      setTimeout(() => tracked.delete(toolUseId), 1500)
    }
  }
}
