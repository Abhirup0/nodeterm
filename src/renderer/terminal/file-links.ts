// Cmd/Ctrl+click links in terminal output. `createUrlLinkProvider` handles http(s) URLs;
// `createFileLinkProvider` handles path-like tokens: absolute (`/x/y`), dot-relative
// (`./x`, `../x`) and bare relatives with at least one slash (`src/a.ts`), with optional
// `:line[:col]` suffixes (compiler/grep output). `~` paths are skipped in v1 (no home
// resolution).
//
// Existence (and dir-ness) is verified before a file link is offered, via a short-TTL cache
// of parent-directory listings — one fs.list covers every sibling on a compiler-error screen.
//
// Long tokens span rows two different ways, and BOTH are joined into one logical paragraph
// (`paragraphContaining`) before matching:
//   - SOFT wrap — xterm wrapped a long streamed line itself; the continuation row carries
//     `isWrapped`. The easy, always-joined case.
//   - HARD wrap — tmux repaints (attach, resize, refresh) and an agent's fullscreen TUI PAINT
//     the screen row by row with explicit cursor moves, so a long line lands as separate
//     full-width rows with NO wrapped flags. This is what a `claude /login` OAuth URL looks
//     like in practice; matching per-row opened just the clicked row's fragment (a truncated,
//     wrong URL). A row is treated as continuing onto the next when it is full to the LAST
//     column and the next row starts at column 0 with a non-space — a heuristic (the buffer
//     genuinely cannot distinguish a repainted wrap from prose that exactly fills the row),
//     gated tightly and capped at MAX_JOIN_ROWS, and the regex still has to match across the
//     seam for a link to result.
import type { ILink, ILinkProvider, Terminal } from '@xterm/xterm'

export interface FileToken {
  /** The raw matched span (drives the underline range), incl. any :line:col suffix. */
  text: string
  /** 0-based index of `text` within the logical line. */
  startIndex: number
  /** The cleaned path portion. */
  path: string
  line?: number
}

// Path-ish token: an optional ./ ../ / prefix, then segments of path-safe chars with at
// least one internal slash — OR a prefixed single-segment (/tmp, ./x) — with an optional
// trailing :line[:col]. Trailing punctuation is cleaned afterwards, not in the regex.
const TOKEN_RE =
  /(?:(?:\.{1,2}\/|\/)?[\w.@+-]+(?:\/[\w.@+~-]+)+|(?:\.{1,2}\/|\/)[\w.@+-]+)(?::\d+(?::\d+)?)?/g
const SUFFIX_RE = /^(.*?):(\d+)(?::\d+)?$/
const TRAILING_PUNCT = /[.,;:!?'")\]}>]+$/

export function matchFileTokens(lineText: string): FileToken[] {
  const out: FileToken[] = []
  for (const m of lineText.matchAll(TOKEN_RE)) {
    let text = m[0]
    // URLs (and protocol-ish tokens) belong to the web-links addon. A token preceded by
    // `~` is a home-relative path minus its tilde (no home resolution in v1) — skip it
    // rather than mis-resolve `~/x` as the absolute `/x`.
    const before = lineText.slice(Math.max(0, m.index - 8), m.index)
    // `\w+:\/{1,2}$` (not just `://`): the optional leading-`/` in TOKEN_RE can swallow the
    // second slash of `://`, so a URL's token starts at that slash and `before` ends `https:/`.
    if (/\w+:\/{1,2}$/.test(before) || text.includes('//')) continue
    if (m.index > 0 && lineText[m.index - 1] === '~') continue
    text = text.replace(TRAILING_PUNCT, '')
    if (text.length < 3) continue
    let path = text
    let line: number | undefined
    const suffix = SUFFIX_RE.exec(text)
    if (suffix) {
      path = suffix[1]
      line = parseInt(suffix[2], 10)
    }
    if (!path || !path.includes('/')) continue
    out.push({ text, startIndex: m.index, path, line })
  }
  return out
}

// http(s) URLs. Shared by createUrlLinkProvider (hover underline + click outside tmux) and
// the mouse-up click fallback (below), which hit-tests URLs and file paths in one pass —
// under tmux/agent mouse-reporting a provider's own click never fires (see
// installLinkClickFallback).
const URL_RE = /\bhttps?:\/\/[^\s"'`<>()[\]{}|\\^]+/gi

export interface UrlToken {
  text: string
  startIndex: number
  url: string
}

export function matchUrlTokens(lineText: string): UrlToken[] {
  const out: UrlToken[] = []
  for (const m of lineText.matchAll(URL_RE)) {
    const text = m[0].replace(TRAILING_PUNCT, '')
    if (text.length < 8) continue // "http://x" is the shortest sane URL
    try {
      const u = new URL(text)
      if (u.protocol !== 'http:' && u.protocol !== 'https:') continue
    } catch {
      continue
    }
    out.push({ text, startIndex: m.index, url: text })
  }
  return out
}

/** Absolute path for a token: absolutes pass through, relatives resolve against cwd,
 *  `.`/`..` segments normalized. Null when unresolvable or when `..` escapes the root.
 *  A home-relative cwd (`~` or `~/proj`, the SSH-project default) keeps its leading `~` as
 *  the first segment — the downstream sshFs stack tilde-expands it via quoteRemotePath, so
 *  `/`-prefixing it (→ `/~/proj`) would break the remote listing. `..` may not pop the `~`. */
export function resolveFileToken(path: string, cwd: string | undefined): string | null {
  const raw = path.startsWith('/') ? path : cwd ? `${cwd.replace(/\/+$/, '')}/${path}` : null
  if (!raw) return null
  const segs = raw.split('/').filter((s) => s && s !== '.')
  const tilde = segs[0] === '~'
  const out: string[] = tilde ? ['~'] : []
  const floor = tilde ? 1 : 0 // the `~` root is fixed; `..` may not pop below it
  for (const seg of tilde ? segs.slice(1) : segs) {
    if (seg === '..') {
      if (out.length <= floor) return null
      out.pop()
    } else out.push(seg)
  }
  return tilde ? out.join('/') : '/' + out.join('/')
}

export interface FileLinkDeps {
  getCwd(): string | undefined
  lookup(abs: string): Promise<{ exists: boolean; dir: boolean }>
  activate(abs: string, dir: boolean): void
}

/** The minimal buffer slice paragraph joining needs — unit tests drive a fake. */
export interface BufferView {
  cols: number
  length: number
  line(row: number): { isWrapped: boolean; text(trimRight: boolean): string } | undefined
}

export function bufferView(term: Terminal): BufferView {
  const buf = term.buffer.active
  return {
    cols: term.cols,
    length: buf.length,
    line: (row) => {
      const l = buf.getLine(row)
      return l
        ? { isWrapped: l.isWrapped, text: (trim: boolean) => l.translateToString(trim) }
        : undefined
    }
  }
}

/** Upper bound on rows joined in each direction — bounds hover work on pathological
 *  full-width walls of text; a wrapped OAuth URL is ~7 rows at 80 cols. */
const MAX_JOIN_ROWS = 32

// Whether `row` runs into `row + 1`: the successor carries xterm's soft-wrap flag, OR the
// hard-wrap heuristic holds — `row` is full to its last column (untrimmed non-space in the
// final cell) and the successor starts at column 0 with a non-space. See the header comment.
function continuesOnNextRow(view: BufferView, row: number): boolean {
  const next = view.line(row + 1)
  if (!next) return false
  if (next.isWrapped) return true
  const cur = view.line(row)
  if (!cur) return false
  const raw = cur.text(false)
  if (raw.length < view.cols || raw[view.cols - 1] === ' ') return false
  const nextRaw = next.text(false)
  return nextRaw.length > 0 && nextRaw[0] !== ' '
}

/**
 * The logical paragraph containing `row` (0-based): walks up to the paragraph's first row,
 * then joins downward across soft AND hard wraps. Every row that continues contributes
 * EXACTLY `cols` characters (padded/truncated untrimmed read), so an index into `text` maps
 * back to the buffer as `(startRow + idx / cols, idx % cols)`; the final row is right-trimmed.
 */
export function paragraphContaining(
  view: BufferView,
  row: number
): { text: string; startRow: number; rows: number } | null {
  if (!view.line(row)) return null
  let start = row
  while (start > 0 && row - start < MAX_JOIN_ROWS && continuesOnNextRow(view, start - 1)) start--
  let text = ''
  let r = start
  for (;;) {
    const joins = r - start + 1 < MAX_JOIN_ROWS && continuesOnNextRow(view, r)
    const lineText = view.line(r)!.text(!joins)
    // Continuing rows must contribute exactly `cols` chars so the index math above holds.
    text += joins ? lineText.padEnd(view.cols).slice(0, view.cols) : lineText
    if (!joins) break
    r++
  }
  return { text, startRow: start, rows: r - start + 1 }
}

/** ILink range (1-based, inclusive) for a token at `startIndex..+len` of a paragraph. */
function tokenRange(
  startRow: number,
  cols: number,
  startIndex: number,
  len: number
): ILink['range'] {
  const endIndex = startIndex + len - 1
  return {
    start: { x: (startIndex % cols) + 1, y: startRow + Math.floor(startIndex / cols) + 1 },
    end: { x: (endIndex % cols) + 1, y: startRow + Math.floor(endIndex / cols) + 1 }
  }
}

/** xterm link provider for file paths. Register once per (non-relay) terminal. */
export function createFileLinkProvider(term: Terminal, deps: FileLinkDeps): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      // Resolve the paragraph CONTAINING the hovered row (not just one starting at it), so
      // hovering any wrapped tail row of a long path underlines and activates the whole token.
      const logical = paragraphContaining(bufferView(term), bufferLineNumber - 1)
      if (!logical) {
        callback(undefined)
        return
      }
      const tokens = matchFileTokens(logical.text)
      if (!tokens.length) {
        callback(undefined)
        return
      }
      const cols = term.cols
      void Promise.all(
        tokens.map(async (t): Promise<ILink | null> => {
          const abs = resolveFileToken(t.path, deps.getCwd())
          if (!abs) return null
          const found = await deps.lookup(abs)
          if (!found.exists) return null
          return {
            text: t.text,
            range: tokenRange(logical.startRow, cols, t.startIndex, t.text.length),
            activate: (event: MouseEvent) => {
              if (!(event.metaKey || event.ctrlKey)) return
              deps.activate(abs, found.dir)
            }
          }
        })
      ).then((links) => {
        const real = links.filter((l): l is ILink => !!l)
        callback(real.length ? real : undefined)
      })
    }
  }
}

/**
 * xterm link provider for http(s) URLs — replaces the WebLinksAddon, which joined soft-wrapped
 * rows but not the hard-wrapped rows a tmux repaint / fullscreen TUI paints (the addon
 * underlined and opened just the first row's fragment of a long OAuth URL). Modifier-gated in
 * activate like the file provider, so plain clicks stay selections.
 */
export function createUrlLinkProvider(term: Terminal, openUrl: (url: string) => void): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const logical = paragraphContaining(bufferView(term), bufferLineNumber - 1)
      if (!logical) {
        callback(undefined)
        return
      }
      const links = matchUrlTokens(logical.text).map(
        (u): ILink => ({
          text: u.text,
          range: tokenRange(logical.startRow, term.cols, u.startIndex, u.text.length),
          activate: (event: MouseEvent) => {
            if (event.metaKey || event.ctrlKey) openUrl(u.url)
          }
        })
      )
      callback(links.length ? links : undefined)
    }
  }
}

/** Existence+dir-ness via cached parent-dir listings (one list covers all siblings). */
export function makeDirListingLookup(
  list: (dir: string) => Promise<Array<{ name: string; dir: boolean }>>,
  ttlMs = 3000
): (abs: string) => Promise<{ exists: boolean; dir: boolean }> {
  const cache = new Map<string, { at: number; entries: Array<{ name: string; dir: boolean }> }>()
  return async (abs) => {
    const i = abs.lastIndexOf('/')
    const dir = i <= 0 ? '/' : abs.slice(0, i)
    const name = abs.slice(i + 1)
    const hit = cache.get(dir)
    const entries =
      hit && Date.now() - hit.at < ttlMs ? hit.entries : await list(dir).catch(() => [])
    if (!hit || Date.now() - (hit?.at ?? 0) >= ttlMs) cache.set(dir, { at: Date.now(), entries })
    const e = entries.find((x) => x.name === name)
    return { exists: !!e, dir: !!e?.dir }
  }
}

// Cell (0-based col, 0-based buffer row) under a mouse event. The canvas applies zoom as a CSS
// transform, so getBoundingClientRect() is already the on-screen (scaled) size — dividing the
// scaled offset by the scaled cell size cancels the zoom, keeping cols/rows constant.
function bufferPosFromEvent(term: Terminal, ev: MouseEvent): { col: number; row: number } | null {
  const screen = term.element?.querySelector('.xterm-screen') as HTMLElement | null
  if (!screen || term.cols <= 0 || term.rows <= 0) return null
  const rect = screen.getBoundingClientRect()
  const x = ev.clientX - rect.left
  const y = ev.clientY - rect.top
  if (x < 0 || y < 0 || x >= rect.width || y >= rect.height) return null
  const cw = rect.width / term.cols
  const ch = rect.height / term.rows
  if (cw <= 0 || ch <= 0) return null
  return {
    col: Math.floor(x / cw),
    row: Math.floor(y / ch) + term.buffer.active.viewportY
  }
}

export interface LinkClickDeps {
  getCwd(): string | undefined
  lookup(abs: string): Promise<{ exists: boolean; dir: boolean }>
  activateFile(abs: string, dir: boolean): void
  openUrl(url: string): void
  /** false for relay-remote nodes (no client fs) — they stay URL-only. */
  fileEnabled(): boolean
}

/**
 * Cmd/Ctrl+click link opening that works INSIDE tmux / an agent's fullscreen TUI. There, the
 * app has mouse-reporting on, so xterm consumes a click as a mouse escape and never runs the
 * registered link provider's `activate` (xterm: `areMouseEventsActive && !shouldForceSelection`
 * ⇒ early return). This capture-phase `mouseup` listener runs BEFORE xterm's mouse handler:
 * gated on the modifier, it hit-tests the buffer itself, opens the link, and stops propagation
 * so the mouse report is never sent. Non-modifier clicks/drags fall through untouched, so tmux
 * copy-mode selection and scrolling are unaffected. Attach to `term.element` so the listener
 * travels with the terminal across park/adopt. Returns a disposer.
 */
export function installLinkClickFallback(
  term: Terminal,
  host: HTMLElement,
  deps: LinkClickDeps
): { dispose(): void } {
  const onMouseUp = (ev: MouseEvent): void => {
    if (ev.button !== 0 || !(ev.metaKey || ev.ctrlKey)) return
    // Only take over when the app has mouse-reporting on (tmux mouse / agent TUI) — that is the
    // exact case where xterm's own link `activate` never fires. With reporting OFF (a plain shell
    // when tmux is unavailable) the registered providers handle the click, so stepping in
    // here would open the link twice.
    if (term.modes.mouseTrackingMode === 'none') return
    const pos = bufferPosFromEvent(term, ev)
    if (!pos) return
    const logical = paragraphContaining(bufferView(term), pos.row)
    if (!logical) return
    const idx = (pos.row - logical.startRow) * term.cols + pos.col
    const inRange = (startIndex: number, len: number): boolean =>
      idx >= startIndex && idx < startIndex + len

    for (const u of matchUrlTokens(logical.text)) {
      if (inRange(u.startIndex, u.text.length)) {
        ev.preventDefault()
        ev.stopPropagation()
        term.clearSelection()
        deps.openUrl(u.url)
        return
      }
    }
    if (!deps.fileEnabled()) return
    for (const t of matchFileTokens(logical.text)) {
      if (inRange(t.startIndex, t.text.length)) {
        const abs = resolveFileToken(t.path, deps.getCwd())
        if (!abs) return
        // Swallow the click NOW so tmux never gets the mouse report; existence is async and a
        // Cmd/Ctrl+click on a path-shaped token is a deliberate open regardless of the outcome.
        ev.preventDefault()
        ev.stopPropagation()
        term.clearSelection()
        void deps.lookup(abs).then((f) => {
          if (f.exists) deps.activateFile(abs, f.dir)
        })
        return
      }
    }
  }
  host.addEventListener('mouseup', onMouseUp, { capture: true })
  return {
    dispose: () => host.removeEventListener('mouseup', onMouseUp, { capture: true })
  }
}
