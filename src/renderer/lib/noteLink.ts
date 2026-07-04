// Pure helpers for canvas link edges: classify a new connection (context link between two
// Claude nodes vs. note link between a sticky and a terminal), build the one-shot push
// message a note link injects into an agent session, and build the link map pushed to main.
// Kept free of React/store imports so the connection matrix is unit-testable.
import type { ContextLinkInfo, ContextLinkMap } from '@shared/types'

export interface LinkEndpoint {
  /** React Flow node type: 'terminal' | 'sticky' | 'editor' | … */
  kind: string
  /** Terminal node whose agent is CONTEXT_LINK_CAPABLE (Claude). */
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

/** Longest note text pushed inline; longer notes are truncated with a pointer to the skill. */
const NOTE_PUSH_MAX = 2000

/**
 * Build the one-shot message injected into an agent session when a note is linked.
 * Single-line by construction: pty.sendText appends Enter and embedded newlines would act
 * as submits in agent REPLs, so newlines are collapsed to a visible ' ⏎ '.
 * Returns null when the note is empty (nothing to push).
 */
export function buildNotePushMessage(title: string, text: string): string | null {
  if (!text.trim()) return null
  const flat = text.replace(/\s*\r?\n\s*/g, ' ⏎ ').trim()
  if (!flat) return null
  const body =
    flat.length > NOTE_PUSH_MAX
      ? flat.slice(0, NOTE_PUSH_MAX) +
        ' … [truncated — read the full note with the get-linked-context skill]'
      : flat
  return `[nodeterm] Sticky note "${title}" linked as context: ${body}`
}

export interface LinkNodeInfo {
  id: string
  title: string
  cwd?: string
  note?: string
  sticky: boolean
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
  const entryOf = (n: LinkNodeInfo): ContextLinkInfo =>
    n.sticky ? { id: n.id, title: n.title, note: n.note ?? '' } : { id: n.id, title: n.title, cwd: n.cwd ?? '' }
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
