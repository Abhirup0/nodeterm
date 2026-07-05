// Pure reducer: one SDK message (structurally typed — no SDK import, so tests use plain
// JSON fixtures) → zero or more ChatEvents for the renderer. Owned by chat-driver.ts.
import type { ChatEvent, ChatMessage, ChatPart, ChatToolSummary } from '../shared/types'

/** The subset of SDK message shapes we consume, typed structurally. */
export interface SdkMessageLike {
  type?: string
  subtype?: string
  session_id?: string
  slash_commands?: string[]
  total_cost_usd?: number
  usage?: { input_tokens?: number; output_tokens?: number }
  event?: { type?: string; delta?: { type?: string; text?: string; thinking?: string } }
  message?: { role?: string; content?: unknown }
}

const lines = (s: unknown): number => (typeof s === 'string' && s.length ? s.split('\n').length : 0)

/** Compact one-line arg + optional file/line summary for a tool_use block. */
export function summarizeToolInput(
  name: string,
  input: Record<string, unknown>
): { arg: string; summary?: ChatToolSummary } {
  const filePath = typeof input.file_path === 'string' ? input.file_path : undefined
  if ((name === 'Edit' || name === 'MultiEdit') && filePath) {
    return { arg: filePath, summary: { filePath, added: lines(input.new_string), removed: lines(input.old_string) } }
  }
  if (name === 'Write' && filePath) {
    return { arg: filePath, summary: { filePath, added: lines(input.content), removed: 0 } }
  }
  const first = input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.prompt
  const arg = typeof first === 'string' ? first : JSON.stringify(input ?? {})
  return { arg: arg.length > 200 ? arg.slice(0, 200) + '…' : arg }
}

const toolResultText = (content: unknown): string => {
  if (typeof content === 'string') return content
  if (Array.isArray(content))
    return content
      .map((b) => (b && typeof b === 'object' && 'text' in b ? String((b as { text: unknown }).text) : ''))
      .join('\n')
  return ''
}

export function sdkMessageToEvents(msg: SdkMessageLike): ChatEvent[] {
  if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
    return [{ kind: 'session', sessionId: msg.session_id, slashCommands: msg.slash_commands ?? [] }]
  }
  if (msg.type === 'stream_event') {
    const d = msg.event?.delta
    if (msg.event?.type === 'content_block_delta' && d) {
      if (d.type === 'text_delta' && d.text) return [{ kind: 'delta', block: 'text', text: d.text }]
      if (d.type === 'thinking_delta' && d.thinking) return [{ kind: 'delta', block: 'thinking', text: d.thinking }]
    }
    return []
  }
  if (msg.type === 'assistant' && Array.isArray((msg.message as { content?: unknown })?.content)) {
    const out: ChatEvent[] = []
    const parts: ChatPart[] = []
    for (const block of (msg.message as { content: Array<Record<string, unknown>> }).content) {
      if (block.type === 'text' && typeof block.text === 'string') parts.push({ kind: 'text', text: block.text })
      else if (block.type === 'thinking' && typeof block.thinking === 'string')
        parts.push({ kind: 'thinking', text: block.thinking })
      else if (block.type === 'tool_use' && typeof block.id === 'string' && typeof block.name === 'string') {
        const { arg, summary } = summarizeToolInput(block.name, (block.input as Record<string, unknown>) ?? {})
        out.push({ kind: 'tool', toolUseId: block.id, name: block.name, arg, summary })
      }
    }
    const msgEvent: ChatEvent[] = parts.length
      ? [{ kind: 'message', msg: { role: 'assistant', parts } satisfies ChatMessage }]
      : []
    return [...msgEvent, ...out]
  }
  if (msg.type === 'user' && Array.isArray((msg.message as { content?: unknown })?.content)) {
    const out: ChatEvent[] = []
    for (const block of (msg.message as { content: Array<Record<string, unknown>> }).content) {
      if (block.type === 'tool_result' && typeof block.tool_use_id === 'string')
        out.push({ kind: 'tool-result', toolUseId: block.tool_use_id, result: toolResultText(block.content) })
    }
    return out
  }
  if (msg.type === 'result') {
    const usage = msg.usage
      ? { inputTokens: msg.usage.input_tokens ?? 0, outputTokens: msg.usage.output_tokens ?? 0 }
      : undefined
    const done: ChatEvent = { kind: 'turn-done', costUsd: msg.total_cost_usd, usage }
    if (msg.subtype && msg.subtype !== 'success')
      return [done, { kind: 'error', message: `Turn ended: ${msg.subtype}`, fatal: false }]
    return [done]
  }
  return []
}
