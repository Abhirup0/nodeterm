// Pure aggregation + ordering for the collapsed Notch HUD indicator (docs/notch-hud.md).
//
// `buildIndicator` is the ONE definition of what the collapsed capsule shows, derived from the same
// row array the expanded panel draws. It lives here rather than beside the main-process HUD model
// because the renderer is the only side that draws it, and a renderer must never import src/main
// (process-model boundary) — a copy over there could only ever be dead code that drifts, which is
// exactly what happened: it never grew the `needsYou` dot this renderer has been drawing.
//
// The ordering below: the indicator hugs the LEFT edge of the notch and reads right→left. agent-notch draws Claude
// rightmost (nearest the notch) and Codex to its left (main.swift IndicatorView.draw: claude is
// drawn first at bounds.maxX, then codex to the left). Our indicator is a normal left→right flex
// row, so the LAST element is the rightmost/notch-side one. This helper returns the working agent
// ids in left→right paint order (Claude last) so the DOM matches agent-notch's slot order.
//
// Kept pure + Electron-free so both are unit-tested without a DOM.

/** The minimal row shape the aggregation reads — a structural subset of the HUD row contract, so
 *  this module needs no type from main/preload (main.ts mirrors that contract locally on purpose). */
export interface IndicatorRow {
  state: 'working' | 'needsYou' | 'done' | 'idle'
  agentId?: string
}

/** What the collapsed capsule draws: a walking mascot per working agent kind, plus the two dots. */
export interface HudIndicator {
  /** Distinct agentIds that have at least one working node (drives a walking mascot slot each),
   *  in first-seen order — pass through `orderIndicatorAgents` for the paint order. */
  workingAgents: string[]
  /** True if any row is a finished-but-unseen (`done`) session → the green blob. */
  doneUnseen: boolean
  /** True if any row is waiting/blocked (`needsYou`) → the red dot. Without it the capsule reads as
   *  EMPTY (and hides) for a session that is waiting on the user while nothing else is working. */
  needsYou: boolean
}

/** Fold the HUD rows into the collapsed indicator's content. */
export function buildIndicator(rows: readonly IndicatorRow[]): HudIndicator {
  const workingAgents: string[] = []
  let doneUnseen = false
  let needsYou = false
  for (const r of rows) {
    if (r.state === 'working') {
      const id = r.agentId || 'unknown'
      if (!workingAgents.includes(id)) workingAgents.push(id)
    } else if (r.state === 'done') {
      doneUnseen = true
    } else if (r.state === 'needsYou') {
      needsYou = true
    }
  }
  return { workingAgents, doneUnseen, needsYou }
}

/** Higher rank = drawn further RIGHT (closer to the notch). Claude is the notch-side anchor. */
const SLOT_RANK: Record<string, number> = {
  claude: 3,
  codex: 2,
  gemini: 1
}

/**
 * Order the distinct working agent ids left→right so the notch-side slot (rightmost, last child)
 * is Claude, then Codex to its left, with any other/custom agents further left. Ties (unknown
 * agents, rank 0) keep their incoming order (a stable sort), so the collapsed strip stays stable
 * frame-to-frame instead of reshuffling as rows re-sort by activity.
 */
export function orderIndicatorAgents(workingAgents: readonly string[]): string[] {
  return workingAgents
    .map((id, i) => ({ id, i, rank: SLOT_RANK[id] ?? 0 }))
    .sort((a, b) => a.rank - b.rank || a.i - b.i)
    .map((e) => e.id)
}
