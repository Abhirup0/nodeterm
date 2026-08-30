// Pure, Electron-free geometry for the macOS Notch HUD (docs/notch-hud.md).
//
// Split out of notch-hud.ts so vitest can cover notch DETECTION without an Electron runtime: the
// controller reads `screen.getPrimaryDisplay()` and hands the plain numbers here. Everything the
// HUD window and its renderer position themselves by is decided in this one function.

/** A rectangle in Electron's logical (point) coordinate space. */
export interface Rect {
  x: number
  y: number
  width: number
  height: number
}

export interface HudGeometryInput {
  /** display.bounds — the full display, menu bar included. */
  bounds: Rect
  /** display.workArea — excludes the menu bar / notch strip. */
  workArea: Rect
  /** display.internal — a notch only ever exists on a built-in panel. */
  internal: boolean
  /** Already-sanitized settings.notchWidth. */
  notchWidth: number
}

export interface HudGeometry {
  x: number
  y: number
  width: number
  height: number
  /** Height of the fused top strip (menu bar / notch), floored so the mascots always fit. */
  bar: number
  notchWidth: number
  notchCenterX: number
  hasNotch: boolean
}

/** Minimum strip height when there is no physical notch (menu-bar height floor). */
export const NOTCH_BAR_FLOOR = 24

/**
 * Notch detection threshold, as a FRACTION of the display's logical height — deliberately not an
 * absolute px count.
 *
 * macOS reserves a menu bar exactly as tall as the notch on a notched panel, so that strip is a
 * fixed share of the panel and survives every scaling mode: a 15" Air reports 37/1112 at its
 * default and 31/932 at 1440x932 — both 0.0333. A notchless panel's menu bar is a fixed 24 pt, so
 * its share instead FALLS as the resolution rises: 24/1080 = 0.0222, 24/900 = 0.0267.
 *
 * The predecessor of this constant was an absolute 32 px, which the 0.0333 share only clears while
 * the display is tall enough — i.e. at the default scaling and nowhere else (issue #508).
 *
 * Residual, and why it is survivable: a notchless BUILT-IN panel driven at an unusually low scaled
 * resolution (24/640 = 0.0375) still reads as notched. That misdetection now costs a capsule fused
 * to a notch that is not there, never a pill hidden behind one — the notchless layout no longer
 * occupies the top strip at all (see `.notchless .hud-capsule` in hud.css).
 */
export const NOTCH_BAR_RATIO = 0.03

/** Total window height ABOVE the top strip — sized to the EXPANDED box (we never resize the frame;
 *  the renderer scales a CSS transform). The strip itself is added on top, because both layouts
 *  start below it: the fused capsule reserves it as padding, the floating pill clears it. */
export const HUD_WINDOW_HEIGHT = 460

/**
 * Decide where the HUD window sits and which of the two layouts its renderer should draw.
 *
 * The window always spans the display's full width at its very top edge (`bounds`, not `workArea`
 * — painting OVER the menu bar is the point, see `enableLargerThanScreen` in notch-hud.ts).
 */
export function hudGeometry(input: HudGeometryInput): HudGeometry {
  const b = input.bounds
  const inset = input.workArea.y - b.y
  const bar = Math.max(NOTCH_BAR_FLOOR, inset)
  // A physical notch requires a built-in panel whose reserved strip is a notch-sized SHARE of it.
  const hasNotch = input.internal && inset > 0 && b.height > 0 && inset / b.height >= NOTCH_BAR_RATIO
  return {
    x: b.x,
    y: b.y,
    width: b.width,
    height: Math.min(bar + HUD_WINDOW_HEIGHT, b.height),
    bar,
    notchWidth: input.notchWidth,
    notchCenterX: Math.round(b.width / 2),
    hasNotch
  }
}
