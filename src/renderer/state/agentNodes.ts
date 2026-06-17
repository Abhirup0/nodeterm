import { create } from 'zustand'

/**
 * Transient visualization of subagents a Claude node spawns (Task/Agent tool), keyed by the
 * tool_use_id from the hooks. These render as ephemeral nodes + edges on the canvas; they are
 * never persisted to workspace.json and never enter undo/redo (see Canvas).
 */
export interface SubagentViz {
  /** The Claude terminal node that spawned this subagent. */
  parentNodeId: string
  /** Subagent type, e.g. 'general-purpose'. */
  type?: string
  /** The task description/prompt. */
  label?: string
  state: 'working' | 'done'
  /** When it started (for the live timer). */
  startedAt: number
  // Filled on finish (from the PostToolUse tool_response):
  durationMs?: number
  tokens?: number
  toolUses?: number
  /** What the subagent produced (shown when the node is expanded). */
  result?: string
  /** Live transcript text streamed while the subagent runs (shown when expanded). */
  activity?: string
}

export interface SubagentResult {
  durationMs?: number
  tokens?: number
  toolUses?: number
  result?: string
}

interface AgentNodesState {
  byId: Record<string, SubagentViz>
  /** User-dragged position overrides for ephemeral nodes (subagent ids + `loop-<parentId>`). */
  positions: Record<string, { x: number; y: number }>
  setPosition(id: string, pos: { x: number; y: number }): void
  start(toolUseId: string, viz: Omit<SubagentViz, 'state' | 'startedAt'>): void
  finish(toolUseId: string, result: SubagentResult): void
  /** Append a chunk of the subagent's live transcript. */
  appendActivity(toolUseId: string, chunk: string): void
  /** Remove all subagents spawned by a given parent node (turn/session ended, or node closed). */
  clearForParent(parentNodeId: string): void
}

export const useAgentNodes = create<AgentNodesState>((set) => ({
  byId: {},
  positions: {},

  setPosition: (id, pos) => set((s) => ({ positions: { ...s.positions, [id]: pos } })),

  start: (toolUseId, viz) =>
    set((s) => ({
      byId: { ...s.byId, [toolUseId]: { ...viz, state: 'working', startedAt: Date.now() } }
    })),

  finish: (toolUseId, result) =>
    set((s) => {
      const prev = s.byId[toolUseId]
      if (!prev || prev.state === 'done') return s
      return { byId: { ...s.byId, [toolUseId]: { ...prev, state: 'done', ...result } } }
    }),

  appendActivity: (toolUseId, chunk) =>
    set((s) => {
      const prev = s.byId[toolUseId]
      if (!prev) return s
      const activity = ((prev.activity ?? '') + chunk).slice(-12000) // keep the tail bounded
      return { byId: { ...s.byId, [toolUseId]: { ...prev, activity } } }
    }),

  clearForParent: (parentNodeId) =>
    set((s) => {
      const ids = Object.keys(s.byId).filter((id) => s.byId[id].parentNodeId === parentNodeId)
      const byId = { ...s.byId }
      for (const id of ids) delete byId[id]
      // Also drop position overrides for those subagents and the parent's loop node.
      const positions = { ...s.positions }
      for (const id of ids) delete positions[id]
      delete positions[`loop-${parentNodeId}`]
      return { byId, positions }
    })
}))
