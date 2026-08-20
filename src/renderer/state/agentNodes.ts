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
  /**
   * Per-ephemeral-node UI overrides (keyed by node id: subagent ids + `loop-<parentId>`).
   * `positions` holds an OFFSET FROM THE PARENT AGENT NODE, not a canvas position: the card
   * always shares the agent's coordinate space (it inherits the agent's `parentId`), so an
   * offset survives the space CHANGING under it. Storing the position itself meant that
   * grouping or ungrouping the agent — which flips its position between absolute and
   * group-relative — teleported every card the user had dragged, by the group's own x/y.
   */
  positions: Record<string, { x: number; y: number }>
  sizes: Record<string, { width: number; height: number }>
  expanded: Record<string, boolean>
  /**
   * The one selected ephemeral card, or null. Kept here (not in React Flow's selection) because
   * the cards are `selectable: false`: a rubber-band or select-all must never sweep up a whole
   * subagent fan-out and hand those ids to Group / Duplicate / Delete, which cannot act on a
   * derived node. Cards select one at a time, by click, purely to show their resize frame.
   */
  selectedId: string | null
  select(id: string | null): void
  setPosition(id: string, offset: { x: number; y: number }): void
  setSize(id: string, size: { width: number; height: number }): void
  toggleExpanded(id: string): void
  /** Drop a card's dragged position + resized size, returning it to its laid-out spot. */
  resetPlacement(id: string): void
  start(toolUseId: string, viz: Omit<SubagentViz, 'state' | 'startedAt'>): void
  finish(toolUseId: string, result: SubagentResult): void
  /** Append a chunk of the subagent's live transcript. */
  appendActivity(toolUseId: string, chunk: string): void
  /** Remove all subagents spawned by a given parent node (turn/session ended, or node closed). */
  clearForParent(parentNodeId: string): void
  /**
   * Drop every dragged position/size/expanded override for a parent's subagent cards, snapping
   * them back to the default packed grid (`offsetFrom`'s fallback in Canvas) at base dims — an
   * expanded card kept at its larger size would still overlap its grid neighbors. Loop cards are
   * excluded — there is only ever one per parent, so there is nothing to pack. If this is ever
   * extended to loop cards, route through `saveLoopOverrides` too, or a cleared `loop-*` entry
   * would resurrect from its localStorage mirror on reload.
   */
  tidyFanout(parentNodeId: string): void
  /**
   * Drop the loop card's UI overrides (position/size/expanded) for a parent. Separate from
   * clearForParent on purpose: a loop/cron card outlives turns, so the per-turn fan-out
   * clear must not reset where the user dragged it — this runs only when the loop ends.
   */
  clearLoop(parentNodeId: string): void
}

// Loop-card overrides survive restarts: the loop itself is persisted (agentStatus), so its
// dragged position/size must be too, or every launch teleports the card back to the default
// spot. Only `loop-*` keys are stored — subagent cards are per-turn.
// v2: `positions` changed meaning from a canvas position to an offset from the parent agent
// node. Reading a v1 entry as an offset would fling the card across the canvas, so the old key is
// simply abandoned — the cost is one reset of a dragged loop card, not a mystery jump.
const LOOP_CARDS_KEY = 'nodeterm.loopCards.v2'

type Overrides = Pick<AgentNodesState, 'positions' | 'sizes' | 'expanded'>

function loadLoopOverrides(): Overrides {
  try {
    const raw = localStorage.getItem(LOOP_CARDS_KEY)
    if (!raw) return { positions: {}, sizes: {}, expanded: {} }
    const d = JSON.parse(raw) as Partial<Overrides>
    return { positions: d.positions ?? {}, sizes: d.sizes ?? {}, expanded: d.expanded ?? {} }
  } catch {
    return { positions: {}, sizes: {}, expanded: {} }
  }
}

function saveLoopOverrides(s: Overrides): void {
  try {
    const pick = <T>(m: Record<string, T>): Record<string, T> =>
      Object.fromEntries(Object.entries(m).filter(([k]) => k.startsWith('loop-')))
    localStorage.setItem(
      LOOP_CARDS_KEY,
      JSON.stringify({ positions: pick(s.positions), sizes: pick(s.sizes), expanded: pick(s.expanded) })
    )
  } catch {
    // ignore quota / serialization errors
  }
}

export const useAgentNodes = create<AgentNodesState>((set) => ({
  byId: {},
  activityById: {},
  selectedId: null,
  ...loadLoopOverrides(),

  select: (id) => set((s) => (s.selectedId === id ? s : { selectedId: id })),

  setPosition: (id, offset) =>
    set((s) => {
      const next = { positions: { ...s.positions, [id]: offset } }
      if (id.startsWith('loop-')) saveLoopOverrides({ ...s, ...next })
      return next
    }),
  setSize: (id, size) =>
    set((s) => {
      const next = { sizes: { ...s.sizes, [id]: size } }
      if (id.startsWith('loop-')) saveLoopOverrides({ ...s, ...next })
      return next
    }),
  toggleExpanded: (id) =>
    set((s) => {
      const next = { expanded: { ...s.expanded, [id]: !s.expanded[id] } }
      if (id.startsWith('loop-')) saveLoopOverrides({ ...s, ...next })
      return next
    }),

  resetPlacement: (id) =>
    set((s) => {
      if (!(id in s.positions) && !(id in s.sizes)) return s
      const positions = { ...s.positions }
      const sizes = { ...s.sizes }
      delete positions[id]
      delete sizes[id]
      if (id.startsWith('loop-')) saveLoopOverrides({ ...s, positions, sizes })
      return { positions, sizes }
    }),

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
      // Loop-card overrides (`loop-<pid>`) are deliberately NOT dropped here — the card
      // outlives turns; its overrides go via clearLoop when the loop itself ends.
      for (const id of ids) {
        delete byId[id]
        delete activityById[id]
        delete positions[id]
        delete sizes[id]
        delete expanded[id]
      }
      // A card that just vanished must not stay "selected" — a later card reusing the id would
      // come back pre-selected.
      const selectedId = s.selectedId && ids.includes(s.selectedId) ? null : s.selectedId
      return { byId, activityById, positions, sizes, expanded, selectedId }
    }),

  tidyFanout: (parentNodeId) =>
    set((s) => {
      const ids = Object.keys(s.byId).filter((id) => s.byId[id].parentNodeId === parentNodeId)
      if (!ids.length) return s
      const positions = { ...s.positions }
      const sizes = { ...s.sizes }
      const expanded = { ...s.expanded }
      for (const id of ids) {
        delete positions[id]
        delete sizes[id]
        delete expanded[id]
      }
      return { positions, sizes, expanded }
    }),

  clearLoop: (parentNodeId) =>
    set((s) => {
      const id = `loop-${parentNodeId}`
      if (!(id in s.positions) && !(id in s.sizes) && !(id in s.expanded)) return s
      const positions = { ...s.positions }
      const sizes = { ...s.sizes }
      const expanded = { ...s.expanded }
      delete positions[id]
      delete sizes[id]
      delete expanded[id]
      saveLoopOverrides({ positions, sizes, expanded })
      return { positions, sizes, expanded, selectedId: s.selectedId === id ? null : s.selectedId }
    })
}))
