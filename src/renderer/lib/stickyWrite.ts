// Pure model for the canvas-control `sticky` verb (issue #144): argument validation, resolving
// which note a `--node <id|title>` ref names, and composing the note's next body from
// --text/--append. In lib/ so it is unit-testable off the Canvas dispatch — same reasoning as
// controlRouting, and the id-then-title convention follows kanban's `resolveColumnRef` ("agents
// naturally pass a title; ids come from `list`").
import { oneLine } from '@shared/one-line'

/** What the resolver needs to know about one canvas node. */
export interface StickyCandidate {
  id: string
  /** True when the node is a sticky note (React Flow `type` / persisted `kind` === 'sticky'). */
  sticky: boolean
  title: string
}

/** The args the verb accepts. Anything else is refused by `parseStickyArgs` — see there for why. */
const STICKY_ARG_KEYS = new Set(['node', 'text', 'append', 'create'])

export interface StickyArgs {
  ref: string
  write: { text?: string; append?: string }
  create: boolean
}

/**
 * Validate the raw arg map into the verb's inputs, or return the refusal.
 *
 * The unknown-key refusal is not pedantry — it is the tripwire for the shim's `--` peek rule. A
 * body that itself starts with `--` (a markdown `---` rule, say) written as two tokens
 * (`--text $'---\n…'`) reaches the server as an EMPTY `text` plus a junk flag named after the
 * body's first token; since `--text=""` legitimately clears a note, accepting that silently WIPES
 * the note and replies ok. The junk flag is the one observable difference, so an unknown key turns
 * the silent wipe into a spoken refusal pointing at the `--text=<value>` form.
 *
 * `create` takes a VALUE (`--create yes`), not bare presence: the repo rule for new verbs is that
 * every flag carries a value so the pre-peek shim still on unreconnected SSH hosts parses the
 * line identically — and a JSON-dialect caller's `{create: false}` must not read as "create".
 */
export function parseStickyArgs(args: Record<string, string>): StickyArgs | { error: string } {
  for (const k of Object.keys(args)) {
    if (!STICKY_ARG_KEYS.has(k)) {
      return {
        error: `unknown flag --${k} — a value that starts with "--" must be written as --text=<value> / --append=<value>`
      }
    }
  }
  const ref = (args.node ?? '').trim()
  if (!ref) return { error: 'requires --node <id|title>' }
  if (args.text !== undefined && args.append !== undefined) {
    return { error: 'pass either --text or --append, not both' }
  }
  if (args.text === undefined && args.append === undefined) {
    return { error: 'requires --text or --append' }
  }
  return {
    ref,
    write: { text: args.text, append: args.append },
    create: /^(yes|true|1)$/i.test(args.create ?? '')
  }
}

export type StickyRefResult = { id: string } | { notFound: true } | { error: string }

/**
 * Resolve `--node <id|title>`: exact id first (ids are the stable handle `list` hands out), then
 * header title among sticky notes. Tri-state like `resolveColumnRef`: not-found is distinct from
 * an error because `--create yes` turns exactly that case into a new note — a typo'd id or an
 * ambiguous title must never silently become one.
 *
 * Titles compare through `oneLine` + lowercase on BOTH sides: a created note's title goes through
 * `oneLine` at the door (same as `rename`), so a ref with an interior control char must land on
 * the note it created last run, not mint a duplicate forever.
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
  const q = oneLine(raw).toLowerCase()
  const byTitle = nodes.filter((n) => n.sticky && oneLine(n.title).toLowerCase() === q)
  if (byTitle.length === 1) return { id: byTitle[0].id }
  if (byTitle.length > 1) {
    return {
      error: `several notes are titled "${raw}" (${byTitle.map((n) => n.id).join(', ')}) — use the node id`
    }
  }
  return { notFound: true }
}

/**
 * Hard cap on a note body, measured the way canvas-mutations measures — `JSON.stringify` length —
 * so it composes with MUTATION_MAX_BYTES (256k for the whole serialized node): a body that passes
 * here can never be what pushes the node past the team-sync ceiling, where the failure is a
 * SILENT stop-syncing-to-peers. A sync loop appending forever hits a spoken refusal here instead.
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
  const size = JSON.stringify(text).length
  if (size > STICKY_TEXT_MAX) {
    return { error: `note body would serialize to ${size} chars — the cap is ${STICKY_TEXT_MAX}` }
  }
  return { text, mode }
}
