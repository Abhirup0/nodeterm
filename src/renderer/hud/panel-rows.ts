// Pure cap + overflow rule for the expanded Notch HUD panel (docs/notch-hud.md).
//
// The panel is a GLANCE surface: it draws only the first few rows of the array main pushes. That
// cap used to be an accident-limiter over a recency sort — the 6th row was whichever session had
// ticked least recently, so it fell off and came back every few seconds and losing it cost
// nothing. Now the array arrives in state-priority order (`hudRowRank`, src/main/notch-hud-model),
// so the cap truncates a MEANINGFUL list: whatever it cuts is the least urgent, but it is still a
// real omission, and a panel that silently shows 6 of 11 sessions is lying by omission about the
// two that need you. Hence `overflowLabel` — the sessions sidebar answers the same question with a
// counted badge (`projectSignalCounts`), and this is that badge for a surface with no room for one.
//
// Kept pure + DOM-free so the cap and the counting are unit-tested without a renderer (main.ts
// draws the result and owns the "show all" toggle).

/** The row shape the split reads — a structural subset of the HUD row contract (main.ts mirrors
 *  that contract locally on purpose, so this module needs no type from main/preload). */
export interface PanelRow {
  state: 'working' | 'needsYou' | 'done' | 'idle'
  unread?: boolean
}

/** How many rows the expanded panel draws before it starts counting instead. */
export const HUD_ROW_CAP = 6

export interface PanelSplit<T> {
  /** The rows actually drawn. */
  shown: T[]
  /** The rows the cap left out, in the same order — never dropped silently, always counted. */
  hidden: T[]
}

/** Split the pushed rows at the cap. Order is preserved on both sides: the caller has already
 *  ranked them, and re-sorting here is exactly the churn the ranking exists to stop. */
export function splitPanelRows<T>(rows: readonly T[], cap = HUD_ROW_CAP): PanelSplit<T> {
  if (cap <= 0) return { shown: [], hidden: [...rows] }
  return { shown: rows.slice(0, cap), hidden: rows.slice(cap) }
}

/**
 * The "+N more" line, broken down by what is hidden — "+3 more · 1 needs you · 2 unread".
 *
 * The words are the sessions sidebar's (`STATUS_GROUP_LABEL`: Need attention / Unread / Running /
 * Idle, lowercased to sit in a count phrase), and the clauses run in the same tier order the rows
 * do, so the line reads as a continuation of the list rather than a separate vocabulary. A tier
 * with nothing in it is omitted entirely — "0 unread" is noise on a strip this narrow.
 *
 * Returns undefined when nothing is hidden, so the caller draws no element at all.
 */
export function overflowLabel(hidden: readonly PanelRow[]): string | undefined {
  if (hidden.length === 0) return undefined
  let needsYou = 0
  let unread = 0
  let working = 0
  let idle = 0
  for (const r of hidden) {
    if (r.state === 'needsYou') needsYou++
    else if (r.state === 'done' && r.unread !== false) unread++
    else if (r.state === 'working') working++
    else idle++
  }
  const parts = [`+${hidden.length} more`]
  if (needsYou) parts.push(`${needsYou} needs you`)
  if (unread) parts.push(`${unread} unread`)
  if (working) parts.push(`${working} running`)
  if (idle) parts.push(`${idle} idle`)
  return parts.join(' · ')
}
