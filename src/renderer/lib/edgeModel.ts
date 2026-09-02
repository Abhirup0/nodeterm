// Pure decisions behind the canvas edge model (spec: docs/superpowers/specs/2026-09-02-canvas-edge-
// model-design.md). A ROPE is the one visible relation between two nodes — "opened by" and
// "sequenced after (--after)" — and its LOOK is derived from the target's pendingLaunch, never
// stored: dashed while the target still waits on the rope's source, solid otherwise. Kept free of
// React/store imports so Canvas.tsx only wraps these in a memo.
import type { PendingLaunch } from '@shared/types'

/** Rope colour for a source with no agent (a browser popup, a plain terminal that opened nothing). */
export const ROPE_NEUTRAL = '#8e8e93'
/** The waiting rope's label. Canvas appends the removal hint when the rope is selected. */
export const WAIT_LABEL = '⏳ waits for'

export interface RopeNodeInfo {
  /** The node's agent colour (AGENT_CONFIG), if it runs an agent. */
  agentColor?: string
  /** The node's `pendingLaunch.after`, if it is armed. */
  pendingAfter?: readonly string[]
}

export interface RopeVisual {
  /** The target is armed and still lists this rope's source among its deps. */
  waiting: boolean
  color: string
}

export function ropeVisual(
  rope: { source: string; target: string },
  info: (id: string) => RopeNodeInfo | undefined
): RopeVisual {
  const waiting = !!info(rope.target)?.pendingAfter?.includes(rope.source)
  const color = info(rope.source)?.agentColor ?? ROPE_NEUTRAL
  return { waiting, color }
}

/**
 * Deleting a WAITING rope is the user saying "do not wait on that one": drop the dep from the
 * target's list and keep everything else. Returns the same object when nothing changes so a caller
 * can skip the state write. An emptied list is left in place — `launchesToFire` treats `[]` as
 * satisfied and fires the held command, which is exactly what removing the last wait should do.
 */
export function dropAfterDep(p: PendingLaunch, depId: string): PendingLaunch {
  if (!p.after.includes(depId)) return p
  return { ...p, after: p.after.filter((d) => d !== depId) }
}

/** Nodes whose eye is closed (`hideFanout`): every edge touching them is hidden from the canvas. */
export function hiddenEdgeNodeIds(
  nodes: readonly { id: string; data: { hideFanout?: boolean } }[]
): Set<string> {
  const out = new Set<string>()
  for (const n of nodes) if (n.data.hideFanout) out.add(n.id)
  return out
}

export function edgeHidden(e: { source: string; target: string }, hidden: ReadonlySet<string>): boolean {
  return hidden.size > 0 && (hidden.has(e.source) || hidden.has(e.target))
}
