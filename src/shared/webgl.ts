/**
 * WebGL context-cap coordination between the desktop shell and the renderer.
 *
 * Chromium caps live WebGL contexts per page (default ~16); past it the browser force-evicts the
 * least-recently-used context, which is what flashes a dead canvas on a visible terminal. The
 * renderer's budget coordinator (`renderer/terminal/webgl-budget.ts`) keeps our own count under a
 * budget so the cap is never hit — but the default cap leaves room for only ~12 GPU-rendered
 * terminals on a busy canvas.
 *
 * On DESKTOP we control the browser too: main raises Chromium's cap via the
 * `--max-active-webgl-contexts` switch (added for exactly this in crbug.com/771792), and the
 * renderer raises the budget to match at boot (`main.tsx` → `setWebglBudget`). The two constants
 * live together here so the "budget comfortably under the cap" invariant is visible in one place.
 * A BROWSER tab (Server Edition) cannot raise its cap, so it stays on the default budget.
 */

/** Chromium's per-page WebGL context cap on desktop (`--max-active-webgl-contexts`). */
export const WEBGL_CONTEXT_CAP_DESKTOP = 32

/** Renderer budget on desktop — comfortably under `WEBGL_CONTEXT_CAP_DESKTOP`, same margin
 *  philosophy as the default 12-under-16. */
export const WEBGL_BUDGET_DESKTOP = 24

/**
 * Renderer budget on MAC desktop, deliberately much lower. Two field reports on macOS point at
 * the OS compositor mishandling many simultaneous WebGL canvases: whole-window flicker (the
 * reason the GPU-rendering master toggle exists), and terminals compositing BLACK after a
 * zoom-out grants a burst of contexts — with zero JS-visible errors in either case (no context
 * loss event, so nothing our repaint heals can reach: `term.refresh` re-draws, the compositor
 * still doesn't present it). Staying under the browser CAP is not enough there — the pressure
 * the macOS compositor tolerates is lower than what Chromium allows. ~10 keeps GPU rendering
 * for the terminals the user is actually looking at while staying inside what macOS
 * compositing handles reliably.
 */
export const WEBGL_BUDGET_DESKTOP_MAC = 10

/**
 * Resolve the `terminalGpuRendering` setting to an effective on/off. 'auto' (the default) is on
 * everywhere EXCEPT macOS: the compositor-level failures above have only ever been observed
 * there, the DOM renderer is the one field-proven-clean configuration on those machines, and a
 * public default must be the proven one — WebGL on a Mac is a deliberate 'on'. Renderer-side
 * only (platform detection is navigator-based). Legacy booleans still resolve sanely if one
 * slips past the settings-store migration.
 */
export function resolveGpuRendering(
  value: 'auto' | 'on' | 'off' | boolean | undefined,
  isMac: boolean
): boolean {
  if (value === 'on' || value === true) return true
  if (value === 'off' || value === false) return false
  return !isMac
}
