// Renders a Claude Code session .jsonl (~/.claude/projects/<proj>/<sessionId>.jsonl) to full
// Markdown. Each line is a JSON object; only `user`/`assistant` message lines carry content
// (other lines are metadata: last-prompt, mode, summary, …). No size cap, no summarization.
import { blockText, fenceJson } from './format'

interface ClaudeLine {
  type?: string
  message?: { role?: string; content?: unknown }
}

export function renderClaudeTranscript(raw: string): string {
  const out: string[] = []
  for (const line of raw.split('\n')) {
    const t = line.trim()
    if (!t) continue
    let o: ClaudeLine
    try {
      o = JSON.parse(t)
    } catch {
      continue
    }
    if (o.type !== 'user' && o.type !== 'assistant') continue
    const role = o.type === 'assistant' ? 'Assistant' : 'User'
    const content = o.message?.content
    if (typeof content === 'string') {
      if (content) out.push(`## ${role}\n\n${content}`)
      continue
    }
    if (!Array.isArray(content)) continue
    for (const c of content as Array<Record<string, unknown>>) {
      const ct = c.type
      if (ct === 'text' && typeof c.text === 'string') {
        out.push(`## ${role}\n\n${c.text}`)
      } else if (ct === 'thinking' && typeof c.thinking === 'string') {
        out.push(`## ${role} (thinking)\n\n${c.thinking}`)
      } else if (ct === 'tool_use') {
        out.push(`### Tool call: ${String(c.name ?? 'tool')}\n\n${fenceJson(c.input)}`)
      } else if (ct === 'tool_result') {
        out.push('### Tool result\n\n```\n' + blockText(c.content) + '\n```')
      } else {
        out.push(`### ${role} block (${String(ct ?? 'unknown')})\n\n${fenceJson(c)}`)
      }
    }
  }
  return out.join('\n\n')
}
