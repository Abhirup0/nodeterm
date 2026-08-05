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
  releaseCursorBlinkTarget,
  restartCursorBlink,
  setCursorBlinkTarget
} from '../canvas/SharedGlyphLayer'
import {
  GlyphGridRendererAddonCore,
  type DeviceMetrics,
  type LinkUnderline,
  type TermInternals
} from '../glyphgrid/addon'
import type { GlyphAtlas } from '../glyphgrid/atlas'
import { packColor } from '../glyphgrid/cells'
import type { DecorationReader } from '../glyphgrid/decorations'
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
/** One entry of xterm's decoration service, as its own renderers read it: the layer defaults to
 *  `bottom`, and either colour may be absent (a marker-only decoration colours nothing). */
interface XtermDecoration {
  options?: { layer?: string }
  backgroundColorRGB?: XtermColor
  foregroundColorRGB?: XtermColor
}
/** xterm's `_decorationService`. OPTIONAL everywhere it appears — see `decorationsOf`. */
interface XtermDecorationService {
  /** A COPY of the decoration list on every read (`[...this._array].values()` in the bundle), so
   *  this is read at attach time and on change events only — NEVER per cell. */
  decorations: Iterable<unknown>
  forEachDecorationAtCell(
    col: number,
    /** ABSOLUTE buffer row — decorations are keyed by their marker's line. */
    row: number,
    layer: string | undefined,
    cb: (d: XtermDecoration) => void
  ): void
  onDecorationRegistered(cb: () => void): { dispose(): void }
  onDecorationRemoved(cb: () => void): { dispose(): void }
}
/** xterm's `linkifier` — the source of the hovered-link underline. OPTIONAL, see `linkUnderlineOf`. */
interface XtermLinkifier {
  onShowLinkUnderline(cb: (e: LinkUnderlineEvent) => void): { dispose(): void }
  onHideLinkUnderline(cb: (e: LinkUnderlineEvent) => void): { dispose(): void }
}
/** What xterm fires: the hovered range in VIEWPORT cell coordinates (`ydisp` already subtracted),
 *  inclusive at both ends. */
interface LinkUnderlineEvent {
  x1: number
  y1: number
  x2: number
  y2: number
}
/**
 * The hovered-link underline, read off xterm's own linkifier.
 *
 * xterm's DOM and WebGL renderers each carry a link render LAYER that subscribes to these two
 * events and draws the underline under a hovered link. Replacing the renderer removes those layers
 * with it, which is why a link in shared mode had no underline at all while GPU mode showed one
 * (reported 2026-08-05, on the `claude /login` URL). This puts the same information back, and the
 * addon renders it through the ordinary underline path rather than a special case.
 *
 * OPTIONAL exactly like `decorationsOf`: a build whose linkifier is missing or reshaped hands back
 * null, `linkUnderline` stays undefined, and the terminal simply never underlines a hovered link —
 * which is where shared mode already was, so the degrade costs nothing that was working.
 *
 * The range is kept HERE rather than in the addon because the addon must not hold xterm objects:
 * this is the same thin-shell rule the decoration reader follows.
 */
function linkUnderlineOf(core: XtermCore): { linkUnderline: LinkUnderline } | null {
  const lk = core.linkifier
  if (!lk || typeof lk.onShowLinkUnderline !== 'function') return null
  if (typeof lk.onHideLinkUnderline !== 'function') return null
  const linkifier = lk as XtermLinkifier

  let current: LinkUnderlineEvent | null = null
  const listeners = new Set<() => void>()
  const notify = (): void => {
    for (const cb of [...listeners]) {
      try {
        cb()
      } catch {
        /* one bad listener must not cost the others their repaint */
      }
    }
  }
  // HIDE clears unconditionally rather than comparing ranges: xterm fires hide for the link that
  // is leaving, and a stale range left standing would underline text the pointer is no longer on.
  const subs = [
    linkifier.onShowLinkUnderline((e) => {
      current = { x1: e.x1, y1: e.y1, x2: e.x2, y2: e.y2 }
      notify()
    }),
    linkifier.onHideLinkUnderline(() => {
      if (!current) return
      current = null
      notify()
    })
  ]

  return {
    linkUnderline: {
      current: () => current,
      onChange: (cb: () => void) => {
        listeners.add(cb)
        return {
          dispose: () => {
            listeners.delete(cb)
            // The xterm subscriptions themselves live for the terminal's life: they are cheap, and
            // dropping them on the last listener would leave a re-attached renderer blind.
            void subs
          }
        }
      }
    }
  }
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
  /** OPTIONAL, unlike every other member here: decorations are an ENHANCEMENT (search highlights),
   *  so an xterm that dropped or reshaped this service must cost the user their highlights, not
   *  their renderer. `coreOf` never checks it; `decorationsOf` shape-checks it and answers null. */
  _decorationService?: Partial<XtermDecorationService>
  linkifier?: Partial<XtermLinkifier>
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

/** What `decorationsOf` hands the addon: the reader the feed consumes, plus the two change events
 *  the addon turns into a deferred full repack. All three or none — see `TermInternals`. */
type DecorationInternals = Pick<
  TermInternals,
  'decorations' | 'onDecorationRegistered' | 'onDecorationRemoved'
>

/** Wrap xterm's decoration service in the feed's `DecorationReader`, or answer null.
 *
 *  THE COST MODEL IS THE WHOLE DESIGN HERE. `empty()` is asked once per packed ROW and
 *  `forEachDecorationAtCell` once per CELL of a decorated terminal, so neither may be expensive:
 *  - `empty()` reads a COUNTER, never the service's `decorations` getter — that getter copies the
 *    whole decoration array on every read (`[...this._array].values()`), which per row per frame
 *    per terminal would be a real allocation storm. The counter is seeded once from that getter
 *    (so decorations registered BEFORE the shared renderer attached are not missed) and then
 *    maintained by the same two events the addon repacks on. It only ever errs UPWARD: a missed
 *    `removed` leaves it high and costs one wasted walk that finds nothing, which is invisible; a
 *    count that lied LOW would silently hide highlights, so nothing is allowed to zero it.
 *  - `atCell` reuses ONE entry object across the whole walk. The feed reads its fields inside the
 *    callback and never retains it (`decorationAt` copies what it wants into locals), so a fresh
 *    object per decoration per cell would be pure garbage.
 *
 *  Colours go through the same `lane()` the theme uses, alpha forced opaque for the same reason:
 *  the engine's plate owns occlusion, and a translucent highlight would punch a hole in the node. */
function decorationsOf(core: XtermCore): DecorationInternals | null {
  const svc = core._decorationService
  if (!svc || typeof svc.forEachDecorationAtCell !== 'function') return null
  if (typeof svc.onDecorationRegistered !== 'function') return null
  if (typeof svc.onDecorationRemoved !== 'function') return null
  const service = svc as XtermDecorationService

  let count = 0
  try {
    for (const _ of service.decorations ?? []) count++
  } catch {
    // Unreadable list: start at zero and let the first registration light it up. Guessing "some"
    // instead would walk every cell of every frame forever on a terminal that has none.
    count = 0
  }

  const entry: { layer?: string; bg?: number; fg?: number } = {}
  const decorations: DecorationReader = {
    empty: () => count <= 0,
    atCell: (col, row, cb) => {
      try {
        // `undefined` layer = every layer; `decorationAt` drops the top one, which is the same
        // filter xterm's own renderers apply at cell level.
        service.forEachDecorationAtCell(col, row, undefined, (d) => {
          entry.layer = d.options?.layer
          entry.bg = d.backgroundColorRGB ? lane(d.backgroundColorRGB) : undefined
          entry.fg = d.foregroundColorRGB ? lane(d.foregroundColorRGB) : undefined
          cb(entry)
        })
      } catch {
        // A decoration service that threw mid-frame must cost this cell its highlight, not the
        // frame — this runs inside the pack loop of a live terminal.
      }
    }
  }

  /** Both events are wrapped so a subscribe that throws cannot take the addon's construction down
   *  with it — the addon treats a no-op disposable as "this terminal simply never changes". */
  const subscribe = (
    fn: (cb: () => void) => { dispose(): void },
    onEvent: () => void,
    cb: () => void
  ): { dispose(): void } => {
    try {
      return fn(() => {
        onEvent()
        cb()
      })
    } catch {
      return { dispose: (): void => {} }
    }
  }

  return {
    decorations,
    onDecorationRegistered: (cb) =>
      subscribe(
        (h) => service.onDecorationRegistered(h),
        () => {
          count++
        },
        cb
      ),
    onDecorationRemoved: (cb) =>
      subscribe(
        (h) => service.onDecorationRemoved(h),
        () => {
          count = Math.max(0, count - 1)
        },
        cb
      )
  }
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
    hasFocus: () => core._coreBrowserService.isFocused,
    // The PUBLIC options object, not an internal — so this needs no guard in `coreOf` and cannot
    // refuse an attach. Read live on every pack: the user can change either from Settings → Terminal
    // at any moment (`applyVisualOptions` writes straight into `term.options`), and a cached copy
    // would keep drawing yesterday's shape until the terminal happened to be re-created.
    //
    // xterm's DEFAULT `cursorInactiveStyle` is `outline` — the hollow box a blurred terminal draws,
    // and precisely the shape limitation L2 said this engine could not express. So the row that
    // looks most exotic in the mapping table is in fact the DEFAULT path: every terminal on the
    // canvas that is not the focused one takes it. The mapping itself lives in `cursor.ts`
    // (`resolveCursorShape`), where it is pure and unit-tested; this file only hands over the two
    // strings, and never the focus flag — the addon tracks focus itself, see `TermInternals`.
    cursorStyle: () => ({
      style: term.options.cursorStyle,
      inactiveStyle: term.options.cursorInactiveStyle
    }),
    // The canvas's cursor-blink clock lives in the shared layer and drives exactly ONE terminal —
    // the focused one — so the addon publishes its own focus edges through here. It is the addon
    // that knows: it tracks focus itself (xterm's handleFocus/handleBlur, see `TermInternals`), and
    // it is also the only thing that can suppress BOTH halves of a cursor for a phase.
    //
    // Not read from xterm at all, so this widens no private surface: the three calls below are ours.
    // The identity guards `release` and `restart` need live INSIDE those two functions rather than
    // here — this file has no unit tests by design, and a guard written out here would be the copy
    // the suite never exercises.
    blink: {
      claim: (target) => setCursorBlinkTarget(target),
      release: (target) => releaseCursorBlinkTarget(target),
      restart: (target) => restartCursorBlink(target)
    },
    // Spread, so a terminal with no usable decoration service leaves all three members undefined —
    // the addon's "this terminal has no highlights" case.
    ...(decorationsOf(core) ?? {}),
    // Same shape for the linkifier: absent leaves `linkUnderline` undefined and the addon simply
    // never underlines a hovered link, which is where shared mode already was.
    ...(linkUnderlineOf(core) ?? {})
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
