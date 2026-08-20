/**
 * The pure filter model behind the Keyboard Shortcuts section's rail: what STATE a row is in,
 * whether a status filter keeps it, and whether the local query finds it.
 *
 * Pure on purpose — it imports nothing but shared types, so the same functions answer for the
 * visible rows and for the counts printed on the segmented pill. The section computes each row's
 * effective binding count once (`commandKeysFor(id).length`) and passes it in; this file never
 * reaches into settings state, which is what lets the counts be computed for ALL rows in one pass
 * without a second read path that could disagree with the rendered list.
 */
import type { CommandDefinition, CommandId, KeybindingOverrides } from '@shared/keybindings'

export type ShortcutStatusFilter = 'all' | 'modified' | 'unassigned' | 'disabled'

export interface ShortcutRowStatus {
  /** The overrides map carries this id — with ANY value, `[]` included. */
  modified: boolean
  /** The override is exactly `[]`, the disable sentinel. */
  disabled: boolean
  /** Zero effective bindings and NOT explicitly disabled — an unbound default like
   *  `canvas.fitAll`, or an override the read path reduced to nothing. */
  unassigned: boolean
}

export function shortcutRowStatus(
  id: CommandId,
  overrides: KeybindingOverrides | undefined,
  effectiveCount: number
): ShortcutRowStatus {
  const override = overrides?.[id]
  const modified = override !== undefined
  // `[]` is the disable sentinel and it is the ONLY thing that reads as disabled. A row with no
  // override and no default (fitAll) is unassigned, not disabled: the difference is whether the
  // user turned it off or nobody ever gave it a chord, and Reset only makes sense for the former.
  const disabled = modified && override.length === 0
  return { modified, disabled, unassigned: effectiveCount === 0 && !disabled }
}

export function rowPassesStatus(
  status: ShortcutRowStatus,
  filter: ShortcutStatusFilter
): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'modified':
      return status.modified
    case 'unassigned':
      return status.unassigned
    case 'disabled':
      return status.disabled
  }
}

/** Mac display glyphs and the words a user would type instead. `commandKeysFor` already emits
 *  `Ctrl`/`Shift`/`Alt` spelled out on non-mac, so only the mac side needs translating. */
const GLYPH_TO_WORD: Readonly<Record<string, string>> = {
  '⌘': 'cmd',
  '⇧': 'shift',
  '⌥': 'alt',
  '⌃': 'ctrl'
}

/** Every spelling of one binding a query may be written in: the glyph run as it appears on a mac
 *  chip (`⌘K`), the plus join (`⌘+K` / `Ctrl+K`), and the plus join with the glyphs spelled out
 *  (`cmd+k`). Kept as separate haystack ENTRIES rather than one concatenated string so a query can
 *  never match across the seam between two bindings. */
function chordSpellings(parts: readonly string[]): string[] {
  return [parts.join(''), parts.join('+'), parts.map((p) => GLYPH_TO_WORD[p] ?? p).join('+')]
}

/**
 * Local search: case-insensitive substring match over the command's title, id, group, the
 * caller's keywords, and every effective binding's display string in all three spellings above —
 * so a user finds a row either by the chord they SEE (`⌘K`) or the one they would TYPE (`cmd+k`).
 * An empty or whitespace-only query matches everything, matching `matchesQuery`'s contract in
 * `./search`.
 *
 * `chords` is `commandKeysFor(id)` output: display parts per effective binding, `[]` when unbound.
 */
export function matchesShortcutQuery(
  def: Pick<CommandDefinition, 'id' | 'title' | 'group'>,
  keywords: readonly string[],
  chords: readonly (readonly string[])[],
  query: string
): boolean {
  const q = query.trim().toLowerCase()
  if (q === '') return true
  const haystack = [
    def.title,
    def.id,
    def.group,
    ...keywords,
    ...chords.flatMap((parts) => chordSpellings(parts))
  ]
  return haystack.some((entry) => entry.toLowerCase().includes(q))
}
