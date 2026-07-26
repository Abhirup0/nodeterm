// Pure helpers for canvas link edges: classify a new connection (context link between two
// agent nodes vs. note link between a sticky and a terminal), build the one-shot push
// message a note link injects into an agent session, and build the link map pushed to main.
// Kept free of React/store imports so the connection matrix is unit-testable.
import type { BridgeLink, CanvasNodeState, ContextLinkInfo, ContextLinkMap } from '@shared/types'

export interface LinkEndpoint {
  /** React Flow node type: 'terminal' | 'sticky' | 'editor' | … */
  kind: string
  /** Terminal node whose agent is CONTEXT_LINK_CAPABLE (claude/codex/gemini). */
  contextCapable: boolean
}

export type LinkKind = 'context' | 'note'

/** Decide what kind of link (if any) a new edge between two nodes forms. */
export function classifyLink(a: LinkEndpoint, b: LinkEndpoint): LinkKind | null {
  const stickies = (a.kind === 'sticky' ? 1 : 0) + (b.kind === 'sticky' ? 1 : 0)
  if (stickies === 0) return a.contextCapable && b.contextCapable ? 'context' : null
  if (stickies === 2) return null
  const other = a.kind === 'sticky' ? b : a
  return other.kind === 'terminal' ? 'note' : null
}

/** One node the plan refused to link, with the reason to report back to the caller. */
export interface SkippedBridge {
  id: string
  why: string
}

export interface BridgePlan {
  /** Edges to append (already deduped against `existing` AND within the batch). */
  edges: BridgeLink[]
  linked: string[]
  skipped: SkippedBridge[]
}

/**
 * Plan the link edges connecting `fromId` to each of `targetIds` — the batch form of what
 * onConnect does for one hand-drawn edge, used by the canvas-control `link` verb and by the
 * open-agent / spawn-team fan-out (which link every session they open back to the opener).
 *
 * Pure so the refusal matrix is testable: the callers live inside Canvas.tsx, where node
 * lookup is a ref read and the result is a setState. `lookup` is injected because a caller
 * that links nodes it created in the SAME tick cannot resolve them off the canvas yet
 * (setNodes is async), and `existing` is passed in rather than read, so a batch also dedupes
 * against itself and not just against what is already on screen.
 */
export function planBridges(
  fromId: string,
  targetIds: string[],
  lookup: (id: string) => LinkEndpoint | null,
  existing: readonly { source: string; target: string }[]
): BridgePlan {
  const edges: BridgeLink[] = []
  const linked: string[] = []
  const skipped: SkippedBridge[] = []
  const se = lookup(fromId)
  const linkedAlready = (a: string, b: string) =>
    [...existing, ...edges].some(
      (e) => (e.source === a && e.target === b) || (e.source === b && e.target === a)
    )
  for (const tid of targetIds) {
    if (tid === fromId) {
      skipped.push({ id: tid, why: 'same node' })
      continue
    }
    const te = lookup(tid)
    if (!se || !te) {
      skipped.push({ id: tid, why: 'no such node' })
      continue
    }
    const kind = classifyLink(se, te)
    if (!kind) {
      skipped.push({
        id: tid,
        why: 'not linkable (needs two context-capable agents, or a sticky + terminal)'
      })
      continue
    }
    // Note edges are stored sticky→terminal regardless of the direction they were requested
    // in, so styling and the link map can key off "source is sticky" (mirrors onConnect).
    const source = kind === 'note' && te.kind === 'sticky' ? tid : fromId
    const target = source === fromId ? tid : fromId
    if (linkedAlready(source, target)) {
      skipped.push({ id: tid, why: 'already linked' })
      continue
    }
    edges.push({ id: `bridge-${source}-${target}`, source, target })
    linked.push(tid)
  }
  return { edges, linked, skipped }
}

/** Longest note text pushed inline; longer notes are truncated with a pointer to the skill. */
const NOTE_PUSH_MAX = 2000

/**
 * Build the one-shot message injected into an agent session when a note is linked.
 * Single-line by construction: pty.sendText appends Enter and embedded newlines would act
 * as submits in agent REPLs, so newlines are collapsed to a visible ' ⏎ '.
 * Returns null when the note is empty (nothing to push).
 */
export function buildNotePushMessage(title: string, text: string, agentId?: string): string | null {
  if (!text.trim()) return null
  const flat = text.replace(/\s*\r?\n\s*/g, ' ⏎ ').trim()
  const pointer =
    !agentId || agentId === 'claude'
      ? 'read the full note with the get-linked-context skill'
      : 'read the full note with the nodeterm linked-context CLI — see the get-linked-context section in your global agent instructions'
  const body =
    flat.length > NOTE_PUSH_MAX ? flat.slice(0, NOTE_PUSH_MAX) + ` … [truncated — ${pointer}]` : flat
  return `[nodeterm] Sticky note "${title}" linked as context: ${body}`
}

/**
 * The one-shot message injected into each endpoint when a context link is drawn.
 * Claude discovers the capability via its installed skill; codex/gemini get the CLI
 * inline (their global-instructions block may not be loaded mid-session). Single-line:
 * pty.sendText appends Enter.
 */
export function buildContextLinkNote(
  agentId: string | undefined,
  otherTitle: string,
  shimPath: string
): string {
  // Both variants must self-defuse: the note is injected + submitted as a prompt, and an
  // agent that reads it as a task launches an unsolicited investigation of the linked node
  // (observed with gemini). "No action needed" keeps it a notification.
  if (!agentId || agentId === 'claude') {
    return `[nodeterm] You are now linked to "${otherTitle}". Use the get-linked-context skill to read its context when you need it. No action needed now — just acknowledge briefly.`
  }
  return `[nodeterm] You are now linked to "${otherTitle}". When you need its context (and only then) run: sh "${shimPath}" list — then summary | transcript | terminal --node <id>. Details are in the get-linked-context section of your global agent instructions. No action needed now — acknowledge briefly and do not run these commands yet.`
}

export interface LinkNodeInfo {
  id: string
  title: string
  cwd?: string
  note?: string
  sticky: boolean
  agentId?: string
  sessionId?: string
  accountId?: string
}

/**
 * Build the node → linked-nodes map pushed to main (which writes the per-node link files).
 * Context edges map both directions; note edges map one direction only — the terminal side
 * gets a { id, title, note } entry, the sticky side gets nothing (a sticky cannot read).
 */
export function buildLinkMap(
  edges: Array<{ source: string; target: string }>,
  infoOf: (id: string) => LinkNodeInfo
): ContextLinkMap {
  const map: ContextLinkMap = {}
  const entryOf = (n: LinkNodeInfo): ContextLinkInfo => {
    if (n.sticky) return { id: n.id, title: n.title, note: n.note ?? '' }
    const e: ContextLinkInfo = { id: n.id, title: n.title, cwd: n.cwd ?? '' }
    if (n.agentId) e.agentId = n.agentId
    if (n.sessionId) e.sessionId = n.sessionId
    if (n.accountId) e.accountId = n.accountId
    return e
  }
  for (const e of edges) {
    const s = infoOf(e.source)
    const t = infoOf(e.target)
    if (s.sticky && t.sticky) continue
    if (s.sticky) {
      ;(map[t.id] ??= []).push(entryOf(s))
    } else if (t.sticky) {
      ;(map[s.id] ??= []).push(entryOf(t))
    } else {
      ;(map[s.id] ??= []).push(entryOf(t))
      ;(map[t.id] ??= []).push(entryOf(s))
    }
  }
  return map
}

/**
 * Link maps for every project EXCEPT the active one, built from the projects store's
 * serialized nodes + bridges. The active project's map is built live from React Flow; this
 * covers the rest, because main's writeLinkFiles clears ALL link files before writing the
 * pushed map — pushing only the active project's map deleted the link files of background
 * projects whose tmux sessions (and agents mid-task) were still running.
 * Node ids are globally unique across projects, so the maps merge without collisions.
 *
 * `agentIdOf` is the hook-status fallback for plain terminals where the user launched an
 * agent CLI by hand: the serialized node carries no agentId, but the status store (fed by
 * the managed hooks, node ids are per-core so background projects share it) knows who's
 * running inside.
 */
export function buildBackgroundLinkMaps(
  projects: Array<{ id: string; nodes: CanvasNodeState[]; bridges?: BridgeLink[] }>,
  activeProjectId: string | null,
  sessionIdOf: (nodeId: string) => string | undefined,
  agentIdOf?: (nodeId: string) => string | undefined
): ContextLinkMap {
  const map: ContextLinkMap = {}
  for (const p of projects) {
    if (p.id === activeProjectId || !p.bridges?.length) continue
    const byId = new Map(p.nodes.map((n) => [n.id, n]))
    const edges = p.bridges.filter((e) => byId.has(e.source) && byId.has(e.target))
    const infoOf = (id: string): LinkNodeInfo => {
      const n = byId.get(id)!
      const sticky = n.kind === 'sticky'
      const agentId = sticky ? undefined : (n.agentId ?? agentIdOf?.(id))
      return {
        id,
        title: n.title || id,
        cwd: n.cwd ?? '',
        note: sticky ? (n.text ?? '') : undefined,
        sticky,
        agentId,
        sessionId: agentId ? sessionIdOf(id) : undefined,
        accountId: sticky ? undefined : n.accountId
      }
    }
    Object.assign(map, buildLinkMap(edges, infoOf))
  }
  return map
}
