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
}

export interface SubagentResult {
  durationMs?: number
  tokens?: number
  toolUses?: number
  result?: string
}

interface AgentNodesState {
  byId: Record<string, SubagentViz>
  /**
   * Live transcript text per subagent, streamed while it runs — kept OUT of `byId` on purpose:
   * Canvas subscribes to `byId` to lay out the ephemeral nodes, and chunks arrive several times
   * a second, so routing them through `byId` re-rendered the whole canvas per chunk. Only the
   * expanded SubagentNode subscribes here, per id.
   */
  activityById: Record<string, string>
  /** Per-ephemeral-node UI overrides (keyed by node id: subagent ids + `loop-<parentId>`). */
  positions: Record<string, { x: number; y: number }>
  sizes: Record<string, { width: number; height: number }>
  expanded: Record<string, boolean>
  setPosition(id: string, pos: { x: number; y: number }): void
  setSize(id: string, size: { width: number; height: number }): void
  toggleExpanded(id: string): void
  start(toolUseId: string, viz: Omit<SubagentViz, 'state' | 'startedAt'>): void
  finish(toolUseId: string, result: SubagentResult): void
  /** Append a chunk of the subagent's live transcript. */
  appendActivity(toolUseId: string, chunk: string): void
  /** Remove all subagents spawned by a given parent node (turn/session ended, or node closed). */
  clearForParent(parentNodeId: string): void
}

export const useAgentNodes = create<AgentNodesState>((set) => ({
  byId: {},
  activityById: {},
  positions: {},
  sizes: {},
  expanded: {},

  setPosition: (id, pos) => set((s) => ({ positions: { ...s.positions, [id]: pos } })),
  setSize: (id, size) => set((s) => ({ sizes: { ...s.sizes, [id]: size } })),
  toggleExpanded: (id) => set((s) => ({ expanded: { ...s.expanded, [id]: !s.expanded[id] } })),

  start: (toolUseId, viz) =>
    set((s) => ({
      byId: { ...s.byId, [toolUseId]: { ...viz, state: 'working', startedAt: Date.now() } }
    })),

  finish: (toolUseId, result) =>
    set((s) => {
      const prev = s.byId[toolUseId]
      if (!prev || prev.state === 'done') return s
      // Async subagents end via a <task-notification> that carries no timing stats — fall
      // back to the card's own elapsed time so the duration doesn't vanish on completion.
      const durationMs = result.durationMs ?? Date.now() - prev.startedAt
      return { byId: { ...s.byId, [toolUseId]: { ...prev, state: 'done', ...result, durationMs } } }
    }),

  appendActivity: (toolUseId, chunk) =>
    set((s) => {
      if (!s.byId[toolUseId]) return s
      const activity = ((s.activityById[toolUseId] ?? '') + chunk).slice(-12000) // bounded tail
      return { activityById: { ...s.activityById, [toolUseId]: activity } }
    }),

  clearForParent: (parentNodeId) =>
    set((s) => {
      const ids = Object.keys(s.byId).filter((id) => s.byId[id].parentNodeId === parentNodeId)
      const byId = { ...s.byId }
      const activityById = { ...s.activityById }
      const positions = { ...s.positions }
      const sizes = { ...s.sizes }
      const expanded = { ...s.expanded }
      const drop = [...ids, `loop-${parentNodeId}`]
      for (const id of ids) {
        delete byId[id]
        delete activityById[id]
      }
      for (const id of drop) {
        delete positions[id]
        delete sizes[id]
        delete expanded[id]
      }
      return { byId, activityById, positions, sizes, expanded }
    })
}))
