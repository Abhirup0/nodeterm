// Pure model for the canvas-control `sticky` verb (issue #144): resolving which note a
// `--node <id|title>` ref names, and composing the note's next body from --text/--append.
// In lib/ so it is unit-testable off the Canvas dispatch — same reasoning as controlRouting,
// and the id-then-title convention follows kanban's `resolveColumnRef` ("agents naturally pass
// a title; ids come from `list`").

/** What the resolver needs to know about one canvas node. */
export interface StickyCandidate {
  id: string
  /** True when the node is a sticky note (React Flow `type === 'sticky'`). */
  sticky: boolean
  title: string
}

export type StickyRefResult = { id: string } | { notFound: true } | { error: string }

/**
 * Resolve `--node <id|title>`: exact id first (ids are the stable handle `list` hands out), then
 * case-insensitive header title among sticky notes. Tri-state like `resolveColumnRef`: not-found
 * is distinct from an error because `--create` turns exactly that case into a new note — a typo'd
 * id or an ambiguous title must never silently become one.
 *
 * The title matched is the HEADER title (`data.title`, what `list` and `rename` report), not the
 * first-line label the kanban board derives — the board's label changes with every rewrite of the
 * body, which is exactly what a synced note does, so it cannot be a stable address.
 */
export function resolveStickyRef(nodes: readonly StickyCandidate[], ref: string): StickyRefResult {
  const raw = ref.trim()
  if (!raw) return { error: 'requires --node <id|title>' }
  const byId = nodes.find((n) => n.id === raw)
  if (byId) {
    if (!byId.sticky) return { error: `node ${byId.id} is not a sticky note` }
    return { id: byId.id }
  }
  const q = raw.toLowerCase()
  const byTitle = nodes.filter((n) => n.sticky && n.title.trim().toLowerCase() === q)
  if (byTitle.length === 1) return { id: byTitle[0].id }
  if (byTitle.length > 1) {
    return {
      error: `several notes are titled "${raw}" (${byTitle.map((n) => n.id).join(', ')}) — use the node id`
    }
  }
  return { notFound: true }
}

/**
 * Hard cap on a note body, in UTF-8 bytes. Deliberately well under canvas-mutations'
 * MUTATION_MAX_BYTES (256 KB for the whole node): a sync loop appending forever should hit a
 * spoken refusal here, not the silent stop-syncing-to-peers failure documented over there.
 */
export const STICKY_TEXT_MAX = 100_000

export type StickyWriteResult = { text: string; mode: 'replace' | 'append' } | { error: string }

/** The note's next body: `--text` replaces, `--append` adds below on its own line. */
export function applyStickyWrite(
  existing: string,
  args: { text?: string; append?: string }
): StickyWriteResult {
  if (args.text !== undefined && args.append !== undefined) {
    return { error: 'pass either --text or --append, not both' }
  }
  const mode: 'replace' | 'append' = args.append !== undefined ? 'append' : 'replace'
  const incoming = args.text ?? args.append
  if (incoming === undefined) return { error: 'requires --text or --append' }
  const text =
    mode === 'replace' || !existing ? incoming : `${existing.replace(/\n+$/, '')}\n${incoming}`
  const bytes = new TextEncoder().encode(text).length
  if (bytes > STICKY_TEXT_MAX) {
    return { error: `note body would be ${bytes} bytes — the cap is ${STICKY_TEXT_MAX}` }
  }
  return { text, mode }
}
