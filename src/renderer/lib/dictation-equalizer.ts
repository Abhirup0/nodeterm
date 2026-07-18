// Press-to-talk recording pill: turns a rolling window of raw amplitude samples
// (`PcmCapture.level()`, 0..1, oldest→newest, one per LEVEL_POLL_MS tick in DictationOverlay)
// into a fixed-length array of bar heights (0..1) for the ~12-bar equalizer. Pure — no side
// effects, no DOM; the component re-renders every poll tick and lets a CSS `transition` on each
// bar's height smooth the visual change between calls, so this only needs to pick the numbers.
//
// Per-bar life comes from feeding one recent sample per bar (newest at the right, scrolling left)
// rather than fanning a single current reading out across a static per-index silhouette (e.g.
// "center bars taller"): real speech has moment-to-moment amplitude variation, and a scrolling
// history renders that variation directly as distinct bar heights — closer to a live waveform. A
// static per-index weight curve would have every bar rise and fall in lockstep off one shared
// reading, which reads as a synced pulse, not "alive". Faster polling (see LEVEL_POLL_MS in
// DictationOverlay, 50ms) feeds more distinct samples into the same visible window, which is what
// actually makes the scroll read as motion instead of a slow crawl.
export const EQUALIZER_BAR_COUNT = 12
// A recording that's just starting (or briefly silent) shouldn't render as 12 flat-zero bars —
// a small floor keeps the pill visibly "alive" instead of looking frozen/broken.
export const EQUALIZER_IDLE_FLOOR = 0.08
// PcmCapture.level() reports RMS amplitude, and speech RMS sits mostly in ~0.05-0.3 — a linear
// pass-through leaves the bars looking flat/dead even while talking, since that whole range sits
// near the bottom of a 0..1 bar. sqrt() bends the low end of that range upward (a perceptual/
// compressor-style curve, same idea as dB metering), and the gain pushes typical speech up into a
// visibly-moving range instead of hugging the floor. Tuned so a quiet take (~0.05 RMS) still reads
// around half height, typical speech (~0.1) sits solidly mid-to-upper height, and louder speech
// (~0.2+) hits full — clamped so nothing overshoots 100%.
export const EQUALIZER_GAIN = 2.5

/**
 * Nonlinear amplitude → bar-height mapping. `raw` is clamped to [0,1] first (NaN/negative/
 * infinite/out-of-range samples count as 0), then mapped through `sqrt(raw) * gain` and clamped
 * back to [0,1]. Pure — see EQUALIZER_GAIN above for why sqrt+gain instead of a linear pass.
 */
export function scaleLevel(raw: number, gain: number = EQUALIZER_GAIN): number {
  const clamped = Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : 0
  return Math.min(1, Math.sqrt(clamped) * gain)
}

/**
 * Maps `history` (oldest→newest amplitude samples) to exactly `barCount` heights, most-recent
 * last. Fewer samples than `barCount` (the first ~600ms of a take at the 50ms poll rate) are
 * left-padded with `idleFloor`; more samples keep only the most recent `barCount`. Each sample is
 * run through `scaleLevel` (nonlinear gain, see above) and then floored at `idleFloor` so the pill
 * never looks fully dead, even during a genuinely silent stretch.
 */
export function equalizerBars(
  history: readonly number[],
  barCount: number = EQUALIZER_BAR_COUNT,
  idleFloor: number = EQUALIZER_IDLE_FLOOR
): number[] {
  const recent = history.slice(Math.max(0, history.length - barCount))
  const bars: number[] = new Array(Math.max(0, barCount - recent.length)).fill(idleFloor)
  for (const raw of recent) {
    bars.push(Math.max(idleFloor, scaleLevel(raw)))
  }
  return bars
}
