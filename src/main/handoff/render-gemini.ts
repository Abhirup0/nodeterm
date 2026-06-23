// Renders a Gemini CLI chat .jsonl (~/.gemini/tmp/<proj>/chats/session-*.jsonl) to full
// Markdown. The file is event-sourced: a header line, then `$set`/`$push` mutations on a
// `messages` array and/or bare appended message objects. We replay them, then render. No
// size cap, no summarization.
import { blockText } from './format'

interface GeminiMsg {
  type?: string
  content?: unknown
  [k: string]: unknown
}

export function renderGeminiTranscript(raw: string): string {
  let messages: GeminiMsg[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let o: Record<string, unknown>
    try {
      o = JSON.parse(t)
    } catch {
      continue
    }
    if (o.$set && typeof o.$set === 'object') {
      const m = (o.$set as Record<string, unknown>).messages
      if (Array.isArray(m)) messages = m as GeminiMsg[]
      continue
    }
    if (o.$push && typeof o.$push === 'object') {
      const m = (o.$push as Record<string, unknown>).messages
      if (Array.isArray(m)) messages.push(...(m as GeminiMsg[]))
      else if (m && typeof m === 'object') messages.push(m as GeminiMsg)
      continue
    }
    // Bare appended message line (has content, no session header marker).
    if (o.content !== undefined && o.sessionId === undefined) {
      messages.push(o as GeminiMsg)
    }
    // Header line ({sessionId, projectHash, kind}) and anything else: skip.
  }
  const out: string[] = []
  for (const m of messages) {
    const role =
      m.type === 'user'
        ? 'User'
        : m.type === 'gemini' || m.type === 'model'
          ? 'Assistant'
          : `Message (${String(m.type ?? 'unknown')})`
    out.push(`## ${role}\n\n${blockText(m.content)}`)
  }
  return out.join('\n\n')
}
