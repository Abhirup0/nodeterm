import { describe, it, expect } from 'vitest'
import { hudGeometry, NOTCH_BAR_FLOOR, HUD_WINDOW_HEIGHT, type HudGeometryInput } from './notch-hud-geometry'

/** A display, described the way Electron reports one: full bounds plus a menu-bar-shortened workArea. */
function display(width: number, height: number, menuBar: number, internal: boolean): HudGeometryInput {
  return {
    bounds: { x: 0, y: 0, width, height },
    workArea: { x: 0, y: menuBar, width, height: height - menuBar },
    internal,
    notchWidth: 168
  }
}

describe('hudGeometry — notch detection across scaling modes (issue #508)', () => {
  // The regression: every one of these is the SAME notched panel, and the absolute-32px predecessor
  // answered true only for the first. The reporter's setting is 1440x932.
  it.each([
    ['15" Air, default 1710x1112', 1710, 1112, 37],
    ['15" Air, scaled 1440x932', 1440, 932, 31],
    ['15" Air, scaled 1280x829', 1280, 829, 28],
    ['14" MBP, default 1512x982', 1512, 982, 37],
    ['16" MBP, default 1728x1117', 1728, 1117, 37]
  ])('detects the notch on %s', (_label, w, h, bar) => {
    expect(hudGeometry(display(w, h, bar, true)).hasNotch).toBe(true)
  })

  it.each([
    ['1080p external', 1920, 1080, 24],
    ['1440p external', 2560, 1440, 24],
    ['scaled 4K external', 3008, 1692, 24],
    ['pre-notch 13" MacBook internal', 1440, 900, 24],
    ['pre-notch MacBook, scaled up', 1680, 1050, 24]
  ])('reports notchless on %s', (_label, w, h, bar) => {
    expect(hudGeometry(display(w, h, bar, false)).hasNotch).toBe(false)
  })

  it('never reports a notch on an external display, whatever its menu bar measures', () => {
    // An external at an unusually low resolution clears the ratio on its own; `internal` is what
    // stops it. Notches do not exist on external panels.
    expect(hudGeometry(display(1024, 640, 24, false)).hasNotch).toBe(false)
  })

  it('reports notchless when the menu bar is hidden entirely', () => {
    expect(hudGeometry(display(1710, 1112, 0, true)).hasNotch).toBe(false)
  })
})

describe('hudGeometry — window placement', () => {
  it('spans the display full width from its very top edge, not the work area', () => {
    const g = hudGeometry({ ...display(1710, 1112, 37, true), bounds: { x: -1710, y: -100, width: 1710, height: 1112 } })
    expect({ x: g.x, y: g.y, width: g.width }).toEqual({ x: -1710, y: -100, width: 1710 })
  })

  it('reserves the top strip ON TOP of the expanded box, so neither layout clips', () => {
    // Both layouts start below the strip: the fused capsule pads it, the pill clears it.
    expect(hudGeometry(display(1710, 1112, 37, true)).height).toBe(37 + HUD_WINDOW_HEIGHT)
  })

  it('never exceeds the display height', () => {
    expect(hudGeometry(display(1024, 300, 24, false)).height).toBe(300)
  })

  it('floors a short menu bar so the mascots always have room', () => {
    expect(hudGeometry(display(1920, 1080, 12, false)).bar).toBe(NOTCH_BAR_FLOOR)
  })

  it('centres the notch anchor on the display', () => {
    expect(hudGeometry(display(1711, 1112, 37, true)).notchCenterX).toBe(856)
  })

  it('passes the sanitized notch width through untouched', () => {
    expect(hudGeometry({ ...display(1710, 1112, 37, true), notchWidth: 220 }).notchWidth).toBe(220)
  })
})
