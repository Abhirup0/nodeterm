// Press-to-talk recording pill: turns a rolling window of raw amplitude samples
// (`PcmCapture.level()`, 0..1, oldest→newest, one per LEVEL_POLL_MS tick in DictationOverlay)
// into a fixed-length array of bar heights (0..1) for the ~12-bar equalizer. Pure — no side
// effects, no DOM; the component re-renders every poll tick and lets a CSS `transition` on each
// bar's height smooth the visual change between calls, so this only needs to pick the numbers.
export const EQUALIZER_BAR_COUNT = 12
// A recording that's just starting (or briefly silent) shouldn't render as 12 flat-zero bars —
// a small floor keeps the pill visibly "alive" instead of looking frozen/broken.
export const EQUALIZER_IDLE_FLOOR = 0.08

/**
 * Maps `history` (oldest→newest amplitude samples) to exactly `barCount` heights, most-recent
 * last. Fewer samples than `barCount` (the first ~1.2s of a take) are left-padded with
 * `idleFloor`; more samples keep only the most recent `barCount`. Each height is clamped to
 * [0,1] and floored at `idleFloor` (NaN/negative samples — a defensive case, `PcmCapture.level()`
 * shouldn't produce them — count as 0 and floor the same way).
 */
export function equalizerBars(
  history: readonly number[],
  barCount: number = EQUALIZER_BAR_COUNT,
  idleFloor: number = EQUALIZER_IDLE_FLOOR
): number[] {
  const recent = history.slice(Math.max(0, history.length - barCount))
  const bars: number[] = new Array(Math.max(0, barCount - recent.length)).fill(idleFloor)
  for (const raw of recent) {
    const clamped = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0
    bars.push(Math.max(idleFloor, clamped))
  }
  return bars
}
