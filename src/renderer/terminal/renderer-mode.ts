import type { TerminalRenderer } from '@shared/webgl'

/**
 * Applying the resolved terminal renderer to the two coordinators that own GPU state: the
 * per-terminal WebGL budget (`terminal/webgl-budget.ts`) and the shared glyph canvas
 * (`canvas/SharedGlyphLayer.tsx`).
 *
 * It is its own function, with the sinks injected, for one reason: the ORDER of the two calls is
 * a correctness contract and nothing else in the codebase can express it. App.tsx is a component,
 * which the (node-environment) suite cannot render; here the contract is a three-line unit test.
 */
export interface RendererModeSinks {
  /** `terminal/webgl-budget.ts` → `setWebglEnabled`. */
  setWebglEnabled(on: boolean): void
  /** `canvas/SharedGlyphLayer.tsx` → `useSharedGlyph.getState().setEnabled`. */
  setSharedEnabled(on: boolean): void
}

/**
 * Put exactly one renderer in charge.
 *
 * **Never both.** Enabling the shared canvas makes every mounted terminal hand its render service
 * to the glyph addon, and the addon's `setRenderer` silently disposes whatever renderer xterm had
 * — including a budgeted WebGL one, which would leave the coordinator accounting for a context
 * nobody paints with while its release path sweeps a canvas out from under a live attachment.
 * So the outgoing renderer is always taken down BEFORE the incoming one comes up:
 *
 * - into 'shared': reclaim every per-terminal context first (each xterm falls back to its DOM
 *   renderer synchronously), then enable the shared canvas;
 * - out of 'shared': disable the shared canvas first — that notification synchronously detaches
 *   every grid and restores xterm's own renderer — and only then let the budget grant again.
 *
 * Both sinks are change-gated at the source, so the mode that did not change costs one comparison.
 */
export function applyRendererMode(mode: TerminalRenderer, sinks: RendererModeSinks): void {
  if (mode === 'shared') {
    sinks.setWebglEnabled(false)
    sinks.setSharedEnabled(true)
    return
  }
  sinks.setSharedEnabled(false)
  sinks.setWebglEnabled(mode === 'webgl')
}
