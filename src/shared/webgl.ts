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
