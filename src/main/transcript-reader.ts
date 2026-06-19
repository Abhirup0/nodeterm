// Reads a Claude session's transcript .jsonl into flat, searchable lines. Read-only and
// local. Mirrors subagent-tail.ts's extraction shape but returns {role, text} per content
// block (instead of a single formatted string) so the renderer can tag matches by role.
import fs from 'fs'
import os from 'os'
import path from 'path'
import type { TranscriptLine } from '../shared/types'

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

export async function readTranscriptLines(filePath: string): Promise<TranscriptLine[]> {
  let buf: string
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
        buf = buffer.toString('utf8')
      } finally {
        await fd.close()
      }
      const nl = buf.indexOf('\n') // drop the first (partial) line
      if (nl >= 0) buf = buf.slice(nl + 1)
    } else {
      buf = await fs.promises.readFile(filePath, 'utf8')
    }
  } catch {
    return []
  }
  const lines: TranscriptLine[] = []
  for (const raw of buf.split('\n')) {
    if (raw.trim()) lines.push(...linesFrom(raw))
  }
  return lines
}

// Fallback when context-tail isn't tracking the session (e.g. resumed after restart):
// find <sessionId>.jsonl anywhere under ~/.claude/projects/*.
export async function resolveTranscriptPath(sessionId: string): Promise<string | undefined> {
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
