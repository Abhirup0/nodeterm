/** The ONE place that touches xterm's private surface for the glyphgrid renderer.
 *
 *  `src/renderer/glyphgrid/` must never import xterm — that isolation is what keeps the engine and
 *  the addon unit-testable and lets an xterm bump break exactly one file. This is that file: it
 *  reads the internals, wraps them in the addon's `TermInternals`, and hands the addon to xterm's
 *  render service as the terminal's renderer.
 *
 *  It has NO unit tests by design (there is no jsdom in which xterm's render service, char-size
 *  measurement and WebGL all exist); it is verified on device. That is exactly why it is kept
 *  small and why every internal access goes through the single guarded `coreOf()` — anything
 *  missing means we return null and the caller stays on xterm's own DOM renderer, which is the
 *  behavior we ship today. */

import type { Terminal } from '@xterm/xterm'
import {
  GlyphGridRendererAddonCore,
  type DeviceMetrics,
  type TermInternals
} from '../glyphgrid/addon'
import type { GlyphAtlas } from '../glyphgrid/atlas'
import { packColor } from '../glyphgrid/cells'
import type { GridHandle } from '../glyphgrid/engine'
import type { CellView, ThemeLanes } from '../glyphgrid/feed'

/** xterm's IColor — `rgba` is 0xRRGGBBAA. */
interface XtermColor {
  rgba: number
}
interface XtermColors {
  foreground: XtermColor
  background: XtermColor
  cursor: XtermColor
  cursorAccent: XtermColor
  selectionBackgroundOpaque: XtermColor
  ansi: XtermColor[]
}
interface XtermLine {
  length: number
  loadCell(col: number, cell: unknown): unknown
}
/** The private members of xterm 5.5 we depend on. Names verified against the shipped bundle. */
interface XtermCore {
  _renderService: { setRenderer(r: unknown): void; handleResize(cols: number, rows: number): void }
  _createRenderer(): unknown
  _themeService: {
    colors: XtermColors
    onChangeColors(cb: (colors: XtermColors) => void): { dispose(): void }
  }
  _charSizeService: { width: number; height: number }
  _coreBrowserService: { dpr: number; isFocused: boolean }
  _bufferService: { buffer: { lines: { get(row: number): XtermLine | undefined } } }
  coreService: { isCursorInitialized: boolean; isCursorHidden: boolean }
}

/** Every internal read in this module starts here. Presence-checked rather than cast, so a bumped
 *  xterm that dropped or renamed one of these degrades to "no glyphgrid" instead of throwing
 *  somewhere inside a render tick.
 *
 *  The LEAVES are checked too, not just the services holding them: `_charSizeService.width/height`
 *  and `_coreBrowserService.dpr` are ARITHMETIC inputs, and a service that exists but reports
 *  `undefined` (renamed field, not-yet-measured stub) would sail through a service-level check and
 *  poison every dimension with NaN — the one thing `updateDims` guards its own math against. Same
 *  for `buffer.lines.get`, which is called per cell inside a render tick. A partially-shaped
 *  internal must produce the contracted null, not a broken terminal. */
function coreOf(term: Terminal): XtermCore | null {
  try {
    const c = (term as unknown as { _core?: Partial<XtermCore> })._core
    if (!c) return null
    if (typeof c._createRenderer !== 'function') return null
    if (!c._renderService || typeof c._renderService.setRenderer !== 'function') return null
    if (typeof c._renderService.handleResize !== 'function') return null
    if (!c._themeService?.colors || typeof c._themeService.onChangeColors !== 'function') return null
    if (!Array.isArray(c._themeService.colors.ansi)) return null
    const cs = c._charSizeService
    if (typeof cs?.width !== 'number' || typeof cs?.height !== 'number') return null
    if (typeof c._coreBrowserService?.dpr !== 'number') return null
    if (typeof c._bufferService?.buffer?.lines?.get !== 'function') return null
    if (!c.coreService) return null
    return c as XtermCore
  } catch {
    return null
  }
}

/** 0xRRGGBBAA → an OPAQUE packed lane. Alpha is forced: the engine's plate owns occlusion in v1,
 *  and a theme's translucent background would otherwise punch a hole in a node. */
function lane(c: XtermColor | undefined): number {
  const v = ((c?.rgba ?? 0) >>> 8) & 0xffffff
  return packColor((v >>> 16) & 0xff, (v >>> 8) & 0xff, v & 0xff, 0xff)
}

function themeLanes(colors: XtermColors): ThemeLanes {
  return {
    fg: lane(colors.foreground),
    bg: lane(colors.background),
    ansi: colors.ansi.map(lane),
    // xterm paints the glyph under a block cursor in `cursorAccent` on `cursor`.
    cursorFg: lane(colors.cursorAccent),
    cursorBg: lane(colors.cursor),
    selectionBg: lane(colors.selectionBackgroundOpaque)
  }
}

/** xterm's own device-metric rounding (DomRenderer._updateDimensions), reproduced exactly: the
 *  addon derives `dimensions.css.cell` from these, and xterm maps MOUSE coordinates through that
 *  — an off-by-a-fraction here puts selection on the wrong line at the bottom of the terminal. */
function deviceMetrics(term: Terminal, core: XtermCore): DeviceMetrics {
  const dpr = core._coreBrowserService.dpr || 1
  const charW = core._charSizeService.width * dpr
  const charH = Math.ceil(core._charSizeService.height * dpr)
  return {
    charW,
    charH,
    cellW: charW + Math.round(term.options.letterSpacing ?? 0),
    cellH: Math.floor(charH * (term.options.lineHeight ?? 1))
  }
}

/** Put xterm back on its own DOM renderer — the same guarded sequence as TerminalNode's
 *  `restoreDomRenderer` safety net. `setRenderer` disposes whatever renderer it replaces, so this
 *  is also what retires the addon. */
function restoreDomRenderer(term: Terminal): boolean {
  const core = coreOf(term)
  if (!core) return false
  try {
    core._renderService.setRenderer(core._createRenderer())
    core._renderService.handleResize(term.cols, term.rows)
    return true
  } catch {
    return false
  }
}

/** What a successful attach hands back. `dispose()` returns whether xterm is BACK ON ITS OWN DOM
 *  RENDERER — false means the terminal is now painting nothing and needs an escalation (respawn),
 *  the same call TerminalNode's stray-canvas heal makes. Do not ignore it. */
export interface GlyphGridAttachment {
  dispose(): boolean
}

function warnRestoreFailed(context: string): void {
  console.warn(`[glyphgrid] DOM renderer restore failed (${context}) — terminal needs a refresh`)
}

/** Point `term` at the shared glyph grid. Returns null — having touched nothing — when the
 *  internals are not what we expect, so the caller simply stays on the DOM renderer. */
export function attachGlyphGrid(
  term: Terminal,
  handle: GridHandle,
  atlas: GlyphAtlas
): GlyphGridAttachment | null {
  const core = coreOf(term)
  if (!core) return null
  let theme = themeLanes(core._themeService.colors)
  // ONE cell object for every read of every frame. `loadCell` fills it in place; the public
  // `getNullCell()` hands back the very CellData class xterm's own renderers allocate, so its
  // getters agree with the buffer's encoding. (The public `buffer.getLine()` path is not used:
  // it allocates a wrapper per call — per CELL here — which is the frame budget.)
  const workCell = term.buffer.active.getNullCell() as unknown as CellView

  const internals: TermInternals = {
    cols: () => term.cols,
    rows: () => term.rows,
    viewportY: () => term.buffer.active.viewportY,
    baseY: () => term.buffer.active.baseY,
    cursorX: () => term.buffer.active.cursorX,
    cursorY: () => term.buffer.active.cursorY,
    cursorVisible: () => core.coreService.isCursorInitialized && !core.coreService.isCursorHidden,
    readCell: (row, col, into) => {
      const line = core._bufferService.buffer.lines.get(row)
      // Past the end of the buffer or of a short line: no cell. The feed renders that as a blank
      // on the theme background — reading past `length` would hand back undefined lanes.
      if (!line || col >= line.length) return undefined
      line.loadCell(col, into)
      return into
    },
    makeWorkCell: () => workCell,
    deviceMetrics: () => deviceMetrics(term, core),
    dpr: () => core._coreBrowserService.dpr || 1,
    theme: () => theme,
    hasFocus: () => core._coreBrowserService.isFocused
  }

  let addon: GlyphGridRendererAddonCore
  try {
    addon = new GlyphGridRendererAddonCore(internals, handle, atlas)
    // The addon IS the renderer object: its public surface is exactly what RenderService calls.
    core._renderService.setRenderer(addon)
  } catch {
    // A throw here can leave xterm holding a half-installed renderer (setRenderer disposed the DOM
    // one first), so restore before reporting failure rather than just returning.
    if (!restoreDomRenderer(term)) warnRestoreFailed('attach')
    return null
  }

  // xterm's render service already schedules a full refresh on a color change; this keeps the
  // snapshot the addon packs from in step with it, and repaints in case the refresh is coalesced
  // away.
  const themeSub = core._themeService.onChangeColors((colors) => {
    theme = themeLanes(colors)
    addon.handleThemeChange()
  })

  let disposed = false
  let restored = false
  return {
    dispose(): boolean {
      if (disposed) return restored
      disposed = true
      try {
        themeSub.dispose()
      } catch {
        // already torn down with the terminal — fine
      }
      restored = restoreDomRenderer(term)
      // Belt and braces: `setRenderer` disposes the addon for us, but if the restore failed the
      // addon must still go inert so it can never write into a grid the node is about to drop.
      addon.dispose()
      // NOT silent: a failed restore means xterm is holding a disposed renderer and the terminal
      // will paint nothing at all — invisible in a log-free teardown, and indistinguishable from
      // "the pty died" to the user staring at a blank node.
      if (!restored) warnRestoreFailed('dispose')
      return restored
    }
  }
}
