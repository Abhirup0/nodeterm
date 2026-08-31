/**
 * UI scale for the application chrome — issue #299 (4K / high-DPI readability).
 *
 * Mechanism: PAGE ZOOM (`webFrame.setZoomFactor` on desktop), the same thing a browser's
 * Cmd/Ctrl+± does. Chosen over a rem-based CSS rewrite because styles.css carries ~2,900 px
 * literals (plus px-valued Tailwind utilities like `text-[13px]`) — a conversion would be a mass
 * rewrite with visual-regression risk on every surface, while page zoom is coordinate math
 * Chromium already maintains: React Flow, xterm and Monaco all run under browser zoom today.
 * Canvas zoom composes independently (it is a CSS transform *inside* the page), and terminal
 * cols/rows re-fit through the ordinary ResizeObserver → FitAddon path when the CSS-px viewport
 * changes — the same reflow a window resize causes.
 *
 * Trade-off, stated in the Settings copy: page zoom scales TERMINAL glyphs too (the terminal
 * font-size setting is in CSS px, so the effective glyph size is fontSize × uiScale). The two
 * settings remain independent *controls*; a user who wants bigger chrome with unchanged terminal
 * text lowers the terminal font size to compensate. Counter-scaling the terminal font
 * automatically was rejected: fractional px font sizes render blurry and silently change
 * cols/rows.
 *
 * Server Edition: intentionally inert — a browser page cannot set its own page zoom, and the
 * browser already owns the identical mechanism (Cmd/Ctrl+±, persisted per site by the browser).
 * The bridge stub is a documented no-op and the Settings row is disabled with that reason
 * (VS Code's `window.zoomLevel` draws the same desktop-only line).
 */

/** The choices the Settings row offers (issue #299's list). A hand-edited value between steps is
 *  honoured, not snapped — the row just shows it as a custom entry. */
export const UI_SCALE_CHOICES = [1, 1.1, 1.25, 1.5, 1.75, 2] as const

/** Clamp bounds for hand-edited settings.json values: 50% keeps the window usable enough to find
 *  the setting again; 200% is the top of the offered range. */
export const UI_SCALE_MIN = 0.5
export const UI_SCALE_MAX = 2

/** Resolve a hand-editable settings value to a safe zoom factor. Anything non-numeric — absent
 *  (every pre-feature settings.json), NaN, Infinity, a string — is 100%; numbers clamp into
 *  [UI_SCALE_MIN, UI_SCALE_MAX] so a wild value can never render the window unusably tiny or
 *  blow it up past recovery. */
export function resolveUiScale(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 1
  return Math.min(UI_SCALE_MAX, Math.max(UI_SCALE_MIN, value))
}

/** "125%" for 1.25 — the Settings row's option labels. */
export function uiScaleLabel(scale: number): string {
  return `${Math.round(scale * 100)}%`
}
