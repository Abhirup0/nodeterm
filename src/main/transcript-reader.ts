// Reads a Claude session's transcript .jsonl into flat, searchable lines. Read-only and
// local. Mirrors subagent-tail.ts's extraction shape but returns {role, text} per content
// block (instead of a single formatted string) so the renderer can tag matches by role.
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { TranscriptLine, ChatMessage, ChatPart } from '../shared/types'

// Only read the last ~5 MB of a transcript so a very large session can't block the main
// process. The older head is dropped silently (search is most useful on recent context).
const READ_CAP_BYTES = 5 * 1024 * 1024

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return (content as Array<{ type?: string; text?: string }>)
      .map((c) => (c?.type === 'text' ? c.text ?? '' : ''))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

function summarizeResult(content: unknown): string {
  return textOf(content).split('\n').slice(0, 3).join(' ').slice(0, 500)
}

function toolArg(input: unknown): string {
  if (!input || typeof input !== 'object') return ''
  const o = input as Record<string, unknown>
  const v = o.command ?? o.file_path ?? o.path ?? o.pattern ?? o.description ?? o.prompt
  return typeof v === 'string' ? v.slice(0, 200) : ''
}

// Extract 0..n searchable lines from one raw transcript JSONL line.
function linesFrom(raw: string): TranscriptLine[] {
  let o: { type?: string; message?: { content?: unknown } }
  try {
    o = JSON.parse(raw)
  } catch {
    return []
  }
  const content = o.message?.content
  const out: TranscriptLine[] = []
  if (o.type === 'assistant' && Array.isArray(content)) {
    for (const c of content as Array<{ type?: string; text?: string; name?: string; input?: unknown }>) {
      if (c.type === 'text' && c.text) out.push({ role: 'assistant', text: c.text })
      else if (c.type === 'tool_use') {
        const arg = toolArg(c.input)
        out.push({ role: 'tool', text: `$ ${c.name ?? 'tool'}${arg ? ` ${arg}` : ''}` })
      }
    }
  } else if (o.type === 'user' && Array.isArray(content)) {
    for (const c of content as Array<{ type?: string; text?: string; content?: unknown }>) {
      if (c.type === 'text' && c.text) out.push({ role: 'user', text: c.text })
      else if (c.type === 'tool_result') {
        const s = summarizeResult(c.content)
        if (s) out.push({ role: 'tool', text: s })
      }
    }
  } else if (o.type === 'user' && typeof content === 'string') {
    out.push({ role: 'user', text: content })
  }
  return out
}

// Read the last ~READ_CAP_BYTES of the file as UTF-8 (dropping the partial leading line on a
// capped read), or the whole file when it's small. Returns undefined if it can't be read.
async function readCappedTail(filePath: string): Promise<string | undefined> {
  try {
    const stat = await fs.promises.stat(filePath)
    if (stat.size > READ_CAP_BYTES) {
      const fd = await fs.promises.open(filePath, 'r')
      try {
        const start = stat.size - READ_CAP_BYTES
        const { buffer } = await fd.read({
          position: start,
          length: READ_CAP_BYTES,
          buffer: Buffer.alloc(READ_CAP_BYTES)
        })
        const s = buffer.toString('utf8')
        const nl = s.indexOf('\n') // drop the first (partial) line
        return nl >= 0 ? s.slice(nl + 1) : s
      } finally {
        await fd.close()
      }
    }
    return await fs.promises.readFile(filePath, 'utf8')
  } catch {
    return undefined
  }
}

export async function readTranscriptLines(filePath: string): Promise<TranscriptLine[]> {
  const buf = await readCappedTail(filePath)
  if (buf === undefined) return []
  const lines: TranscriptLine[] = []
  for (const raw of buf.split('\n')) {
    if (raw.trim()) lines.push(...linesFrom(raw))
  }
  return lines
}

// Reconstruct structured chat messages from raw transcript JSONL lines. An assistant line's
// text + tool_use blocks become one message's ordered parts; a later user-line tool_result is
// correlated back onto its tool part by tool_use_id. User lines that carry only tool_results
// (no prose) are NOT rendered as bubbles — they're tool output, attached to the tool instead.
export function parseChatMessages(rawLines: string[]): ChatMessage[] {
  const messages: ChatMessage[] = []
  const toolById = new Map<string, Extract<ChatPart, { kind: 'tool' }>>()
  for (const raw of rawLines) {
    if (!raw.trim()) continue
    let o: { type?: string; message?: { content?: unknown } }
    try {
      o = JSON.parse(raw)
    } catch {
      continue
    }
    const content = o.message?.content
    if (o.type === 'assistant' && Array.isArray(content)) {
      const parts: ChatPart[] = []
      for (const c of content as Array<{
        type?: string
        text?: string
        name?: string
        id?: string
        input?: unknown
      }>) {
        if (c.type === 'text' && c.text) parts.push({ kind: 'text', text: c.text })
        else if (c.type === 'tool_use') {
          const part: Extract<ChatPart, { kind: 'tool' }> = {
            kind: 'tool',
            name: c.name ?? 'tool',
            arg: toolArg(c.input)
          }
          parts.push(part)
          if (c.id) toolById.set(c.id, part)
        }
      }
      if (parts.length) messages.push({ role: 'assistant', parts })
    } else if (o.type === 'user' && Array.isArray(content)) {
      const parts: ChatPart[] = []
      for (const c of content as Array<{
        type?: string
        text?: string
        tool_use_id?: string
        content?: unknown
      }>) {
        if (c.type === 'text' && c.text) parts.push({ kind: 'text', text: c.text })
        else if (c.type === 'tool_result') {
          const tool = c.tool_use_id ? toolById.get(c.tool_use_id) : undefined
          if (tool) {
            const s = summarizeResult(c.content)
            if (s) tool.result = s
          }
        }
      }
      if (parts.length) messages.push({ role: 'user', parts })
    } else if (o.type === 'user' && typeof content === 'string' && content.trim()) {
      messages.push({ role: 'user', parts: [{ kind: 'text', text: content }] })
    }
  }
  return messages
}

export async function readChatMessages(filePath: string): Promise<ChatMessage[]> {
  const buf = await readCappedTail(filePath)
  if (buf === undefined) return []
  return parseChatMessages(buf.split('\n'))
}

// Claude session ids are UUID-like (hex + dashes). Reject anything else before it
// touches the filesystem — this alone prevents path traversal (no '/' or '.' possible).
export const SESSION_ID_RE = /^[0-9a-fA-F-]{8,64}$/

// Fallback when context-tail isn't tracking the session (e.g. resumed after restart):
// find <sessionId>.jsonl anywhere under ~/.claude/projects/*.
export async function resolveTranscriptPath(sessionId: string): Promise<string | undefined> {
  if (!SESSION_ID_RE.test(sessionId)) return undefined
  const root = path.join(os.homedir(), '.claude', 'projects')
  let dirs: string[]
  try {
    dirs = await fs.promises.readdir(root)
  } catch {
    return undefined
  }
  for (const d of dirs) {
    const p = path.join(root, d, `${sessionId}.jsonl`)
    try {
      await fs.promises.access(p)
      return p
    } catch {
      /* keep looking */
    }
  }
  return undefined
}

// Durable resolver by working directory: Claude stores a project's transcripts under
// ~/.claude/projects/<cwd with every '/' and '.' replaced by '-'>/. We pick the most
// recently modified .jsonl there — the node's active session. Unlike the sessionId path
// this needs no live hook event, so the find-bar works even after a reload/restart or when
// reattaching to a session this app instance didn't spawn. (Encoding leaves no '/', so it
// can't traverse.) Limitation: multiple Claude nodes in the SAME cwd resolve to the same
// newest transcript — the sessionId path above is preferred when known for that reason.
export async function transcriptPathForCwd(cwd: string): Promise<string | undefined> {
  if (!cwd) return undefined
  const encoded = cwd.replace(/[/.]/g, '-')
  const dir = path.join(os.homedir(), '.claude', 'projects', encoded)
  let entries: string[]
  try {
    entries = await fs.promises.readdir(dir)
  } catch {
    return undefined
  }
  let newest: { path: string; mtime: number } | undefined
  for (const e of entries) {
    if (!e.endsWith('.jsonl')) continue
    const p = path.join(dir, e)
    try {
      const st = await fs.promises.stat(p)
      if (!newest || st.mtimeMs > newest.mtime) newest = { path: p, mtime: st.mtimeMs }
    } catch {
      /* skip */
    }
  }
  return newest?.path
}
