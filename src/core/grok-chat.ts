// grok's `chat_history.jsonl` as the ⌘M panel's structured messages.
//
// Separate from `transcript-reader.ts`'s `parseChatMessages`, which parses CLAUDE's shape
// (`o.message.content`, `tool_use`/`tool_result` blocks) and would return an empty thread for every
// grok line. Sharing that function was never an option; sharing the SHAPE knowledge is, so this
// builds on `grokParse` rather than re-deriving grok's line vocabulary and drifting from it.
import type { ChatMessage, ChatPart } from '../shared/types'
import { grokParse } from './context-link-render'

const TOOL_ARG_MAX = 200
const TOOL_RESULT_MAX = 500

function textOf(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : ((c as { text?: string })?.text ?? '')))
      .filter(Boolean)
      .join('\n')
  }
  return ''
}

/**
 * Ordered bubbles for a grok conversation.
 *
 * Two rules carried over from `linesFromGrok`, because breaking either one here would be a
 * behaviour difference between two views of the same file:
 *
 *  - A `user` line with `synthetic_reason` was injected by the harness, not typed by a person. It is
 *    rendered as an ASSISTANT-side note prefixed with its reason rather than as a user bubble — the
 *    panel has only two roles, and the one thing that must never happen is tooling text appearing in
 *    the shape of something the human said.
 *  - `reasoning` is skipped. Its `encrypted_content` is unreadable, and its plaintext `summary` is
 *    omitted by the same product decision documented in `context-link-render.ts`.
 */
export function chatMessagesFromGrok(buf: string): ChatMessage[] {
  const messages: ChatMessage[] = []
  const toolById = new Map<string, Extract<ChatPart, { kind: 'tool' }>>()
  for (const o of grokParse(buf).lines) {
    switch (o.type) {
      case 'user': {
        const t = textOf(o.content)
        if (!t) break
        const injected = typeof o.synthetic_reason === 'string' ? o.synthetic_reason.trim() : ''
        if (injected) {
          messages.push({ role: 'assistant', parts: [{ kind: 'text', text: `[${injected}] ${t}` }] })
        } else {
          messages.push({ role: 'user', parts: [{ kind: 'text', text: t }] })
        }
        break
      }
      case 'system': {
        const t = textOf(o.content)
        if (t) messages.push({ role: 'assistant', parts: [{ kind: 'text', text: `[system] ${t}` }] })
        break
      }
      case 'assistant': {
        const parts: ChatPart[] = []
        const t = textOf(o.content)
        if (t) parts.push({ kind: 'text', text: t })
        for (const c of o.tool_calls ?? []) {
          const a = typeof c.arguments === 'string' ? c.arguments : JSON.stringify(c.arguments ?? '')
          const part: Extract<ChatPart, { kind: 'tool' }> = {
            kind: 'tool',
            name: c.name || 'tool',
            arg: String(a).slice(0, TOOL_ARG_MAX)
          }
          parts.push(part)
          if (c.id) toolById.set(c.id, part)
        }
        if (parts.length) messages.push({ role: 'assistant', parts })
        break
      }
      case 'tool_result': {
        // Attached to the call it answers, never rendered as its own bubble — same as claude's
        // reader. An orphan result (no matching id) is dropped rather than shown speaker-less.
        const tool = o.tool_call_id ? toolById.get(o.tool_call_id) : undefined
        if (!tool) break
        const s = textOf(o.content).slice(0, TOOL_RESULT_MAX)
        if (s) tool.result = s
        break
      }
      case 'backend_tool_call': {
        const q = o.kind?.action?.query
        messages.push({
          role: 'assistant',
          parts: [
            {
              kind: 'tool',
              name: o.kind?.tool_type || 'backend_tool',
              arg: typeof q === 'string' ? q.slice(0, TOOL_ARG_MAX) : ''
            }
          ]
        })
        break
      }
      default:
        break
    }
  }
  return messages
}
