// Renders a Codex rollout .jsonl (~/.codex/sessions/YYYY/MM/DD/rollout-*-<sessionId>.jsonl)
// to full Markdown. Conversation content lives in `response_item` payloads; meta/event lines
// are skipped. No size cap, no summarization.
import { blockText, fenceJson } from './format'

interface CodexLine {
  type?: string
  payload?: Record<string, unknown>
}

export function renderCodexTranscript(raw: string): string {
  const out: string[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let o: CodexLine
    try {
      o = JSON.parse(t)
    } catch {
      continue
    }
    if (o.type !== 'response_item' || !o.payload) continue
    const p = o.payload
    const pt = p.type
    if (pt === 'message') {
      const role = String(p.role ?? 'assistant')
      const heading =
        role === 'user' ? 'User' : role === 'assistant' ? 'Assistant' : `Message (${role})`
      out.push(`## ${heading}\n\n${blockText(p.content)}`)
    } else if (pt === 'reasoning') {
      const body = blockText(p.summary) || blockText(p.content)
      out.push(`## Assistant (reasoning)\n\n${body}`)
    } else if (pt === 'function_call') {
      const args =
        typeof p.arguments === 'string' ? '```\n' + p.arguments + '\n```' : fenceJson(p.arguments)
      out.push(`### Tool call: ${String(p.name ?? 'tool')}\n\n${args}`)
    } else if (pt === 'function_call_output') {
      out.push('### Tool result\n\n```\n' + blockText(p.output) + '\n```')
    } else {
      out.push(`### Item (${String(pt ?? 'unknown')})\n\n${fenceJson(p)}`)
    }
  }
  return out.join('\n\n')
}
