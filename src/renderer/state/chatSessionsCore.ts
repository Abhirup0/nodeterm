// src/renderer/state/chatSessionsCore.ts
// Pure reducer for chat node state — kept out of the zustand store so it's unit-testable
// (same split as noteLink.ts / agentNodes patterns).
import type { ChatEvent, ChatMessage, ChatQueueItem, ChatToolSummary } from '@shared/types'

export interface ChatNodeState {
  messages: ChatMessage[]
  streamText: string
  streamThinking: string
  tools: Record<string, { name: string; arg: string; summary?: ChatToolSummary; result?: string }>
  toolOrder: string[]
  queue: ChatQueueItem[]
  permission?: { requestId: string; toolName: string; input: unknown }
  slashCommands: string[]
  sessionId?: string
  costUsd: number
  working: boolean
  error?: { message: string; fatal?: boolean }
}

export const emptyChatNodeState: ChatNodeState = {
  messages: [], streamText: '', streamThinking: '', tools: {}, toolOrder: [],
  queue: [], slashCommands: [], costUsd: 0, working: false
}

export function applyChatEvent(s: ChatNodeState, e: ChatEvent): ChatNodeState {
  switch (e.kind) {
    case 'session':
      return { ...s, sessionId: e.sessionId, slashCommands: e.slashCommands }
    case 'delta':
      return e.block === 'text'
        ? { ...s, streamText: s.streamText + e.text, working: true }
        : { ...s, streamThinking: s.streamThinking + e.text, working: true }
    case 'message':
      // The completed assistant message is authoritative — replace the delta-built buffer.
      return { ...s, messages: [...s.messages, e.msg], streamText: '', streamThinking: '' }
    case 'tool':
      return {
        ...s,
        tools: { ...s.tools, [e.toolUseId]: { name: e.name, arg: e.arg, summary: e.summary } },
        toolOrder: [...s.toolOrder, e.toolUseId]
      }
    case 'tool-result': {
      const t = s.tools[e.toolUseId]
      if (!t) return s
      return { ...s, tools: { ...s.tools, [e.toolUseId]: { ...t, result: e.result } } }
    }
    case 'permission':
      return { ...s, permission: { requestId: e.requestId, toolName: e.toolName, input: e.input } }
    case 'permission-done':
      return s.permission?.requestId === e.requestId ? { ...s, permission: undefined } : s
    case 'turn-done': {
      // Tool calls stream as live cards (toolOrder) but the completed 'message' event carries
      // only text/thinking. Before clearing toolOrder at turn end, fold this turn's tools into
      // committed history as a synthetic assistant message so the cards (incl. diff-preview
      // links) survive the turn instead of vanishing until a transcript reload.
      const committed: ChatMessage[] =
        s.toolOrder.length > 0
          ? [
              {
                role: 'assistant',
                parts: s.toolOrder.map((id) => {
                  const t = s.tools[id]
                  return { kind: 'tool', name: t.name, arg: t.arg, result: t.result, summary: t.summary }
                })
              }
            ]
          : []
      return {
        ...s,
        messages: committed.length ? [...s.messages, ...committed] : s.messages,
        working: false, toolOrder: [], streamText: '', streamThinking: '',
        costUsd: s.costUsd + (e.costUsd ?? 0)
      }
    }
    case 'queue':
      return { ...s, queue: e.items }
    case 'error':
      return { ...s, error: { message: e.message, fatal: e.fatal } }
  }
}
