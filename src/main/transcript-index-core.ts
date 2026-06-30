// Pure helpers for the transcript index: extract searchable fields from a transcript's raw
// JSONL text, build snippets, and rank sessions by a query. No filesystem access — the
// service layer (transcript-index.ts) reads files and calls these. Reuses the same JSONL
// parser as the single-session reader so indexed text stays consistent with the find-bar.
import { parseTranscriptLines } from './transcript-reader'

export const INDEX_TEXT_CAP_BYTES = 200 * 1024

export interface TranscriptIndexEntry {
  sessionId: string
  transcriptPath: string
  cwd: string
  mtime: number
  title: string
  text: string
}

export interface TranscriptHit {
  sessionId: string
  title: string
  snippet: string
  cwd: string
  projectLabel: string
  mtime: number
}

// Read `cwd` from the first JSONL line that carries it (every Claude line does); reliable,
// unlike decoding the dashed directory name.
function firstCwd(rawText: string): string {
  for (const raw of rawText.split('\n')) {
    if (!raw.trim()) continue
    try {
      const o = JSON.parse(raw) as { cwd?: unknown }
      if (typeof o.cwd === 'string' && o.cwd) return o.cwd
    } catch {
      /* skip */
    }
  }
  return ''
}

export function extractEntryFields(rawText: string): { cwd: string; title: string; text: string } {
  const lines = parseTranscriptLines(rawText)
  const firstUser = lines.find((l) => l.role === 'user')
  const title = (firstUser?.text ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)
  let text = lines.map((l) => l.text).join('\n')
  if (text.length > INDEX_TEXT_CAP_BYTES) text = text.slice(text.length - INDEX_TEXT_CAP_BYTES)
  return { cwd: firstCwd(rawText), title, text }
}

export function makeSnippet(text: string, query: string): string {
  const i = text.toLowerCase().indexOf(query.toLowerCase())
  if (i < 0) return text.slice(0, 160).replace(/\s+/g, ' ').trim()
  const start = Math.max(0, i - 60)
  return (
    (start > 0 ? '…' : '') +
    text.slice(start, start + 160).replace(/\s+/g, ' ').trim()
  )
}

export function searchEntries(
  entries: TranscriptIndexEntry[],
  query: string,
  limit = 20
): TranscriptHit[] {
  const q = query.trim().toLowerCase()
  if (q.length < 2) return []
  return entries
    .filter((e) => e.title.toLowerCase().includes(q) || e.text.toLowerCase().includes(q))
    .sort((a, b) => b.mtime - a.mtime)
    .slice(0, limit)
    .map((e) => ({
      sessionId: e.sessionId,
      title: e.title || e.sessionId,
      snippet: makeSnippet(`${e.title}\n${e.text}`, q),
      cwd: e.cwd,
      projectLabel: e.cwd ? e.cwd.split('/').filter(Boolean).pop() ?? e.cwd : '',
      mtime: e.mtime
    }))
}
