// src/renderer/state/chatSessions.ts
// Transient per-chat-node conversation state (agentNodes.ts pattern): fed by chat:event
// IPC, seeded from the on-disk transcript, never persisted (the transcript already is).
import { create } from 'zustand'
import type { ChatEvent, ChatMessage } from '@shared/types'
import { applyChatEvent, emptyChatNodeState, type ChatNodeState } from './chatSessionsCore'

interface ChatSessionsStore {
  byId: Record<string, ChatNodeState>
  apply(nodeId: string, e: ChatEvent): void
  seed(nodeId: string, messages: ChatMessage[]): void
  addLocalUser(nodeId: string, text: string): void
  clearError(nodeId: string): void
  drop(nodeId: string): void
}

export const useChatSessions = create<ChatSessionsStore>((set) => ({
  byId: {},
  apply: (nodeId, e) =>
    set((st) => ({ byId: { ...st.byId, [nodeId]: applyChatEvent(st.byId[nodeId] ?? emptyChatNodeState, e) } })),
  seed: (nodeId, messages) =>
    set((st) => ({
      byId: { ...st.byId, [nodeId]: { ...(st.byId[nodeId] ?? emptyChatNodeState), messages } }
    })),
  addLocalUser: (nodeId, text) =>
    set((st) => {
      const s = st.byId[nodeId] ?? emptyChatNodeState
      return {
        byId: {
          ...st.byId,
          [nodeId]: { ...s, messages: [...s.messages, { role: 'user', parts: [{ kind: 'text', text }] }] }
        }
      }
    }),
  clearError: (nodeId) =>
    set((st) => {
      const s = st.byId[nodeId]
      if (!s) return {}
      // Clearing the error (Dismiss / Reconnect) must also drop a stale "working" badge and any
      // orphaned permission card left behind by a fatal crash mid-turn — otherwise they survive
      // the reconnect with no live driver behind them.
      return { byId: { ...st.byId, [nodeId]: { ...s, error: undefined, working: false, permission: undefined } } }
    }),
  drop: (nodeId) =>
    set((st) => {
      const byId = { ...st.byId }
      delete byId[nodeId]
      return { byId }
    })
}))
