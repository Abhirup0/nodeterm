// Pure ordering for the collapsed Notch HUD indicator (docs/notch-hud.md).
//
// The indicator hugs the LEFT edge of the notch and reads right→left. agent-notch draws Claude
// rightmost (nearest the notch) and Codex to its left (main.swift IndicatorView.draw: claude is
// drawn first at bounds.maxX, then codex to the left). Our indicator is a normal left→right flex
// row, so the LAST element is the rightmost/notch-side one. This helper returns the working agent
// ids in left→right paint order (Claude last) so the DOM matches agent-notch's slot order.
//
// Kept pure + Electron-free so it is unit-tested without a DOM.

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
