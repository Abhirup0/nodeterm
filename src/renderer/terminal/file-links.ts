// Cmd/Ctrl+click file-path links in terminal output. URLs are the WebLinksAddon's job;
// this provider handles path-like tokens: absolute (`/x/y`), dot-relative (`./x`, `../x`)
// and bare relatives with at least one slash (`src/a.ts`), with optional `:line[:col]`
// suffixes (compiler/grep output). `~` paths are skipped in v1 (no home resolution).
//
// Existence (and dir-ness) is verified before a link is offered, via a short-TTL cache of
// parent-directory listings — one fs.list covers every sibling on a compiler-error screen.
// Wrapped rows are joined into one logical line so long paths still match; the provider
// only fires from a logical line's FIRST row, whose link ranges span the wrapped rows.
// A continuation row resolves to NO links of its own (the provider returns undefined for it),
// so hovering a wrapped tail directly is a known non-clickable v1 limitation.
import type { IBufferLine, ILink, ILinkProvider, Terminal } from '@xterm/xterm'

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

// Join a logical (soft-wrapped) line starting at row `startRow` (0-based). Rows that have a
// wrapped successor are read untrimmed (they are exactly `cols` wide, keeping index math
// exact); the last row is right-trimmed.
function logicalLine(term: Terminal, startRow: number): { text: string; rows: number } | null {
  const buf = term.buffer.active
  const first = buf.getLine(startRow)
  if (!first || first.isWrapped) return null // continuation rows are the first row's job
  let text = ''
  let rows = 0
  let cur: IBufferLine | undefined = first
  while (cur) {
    const next = buf.getLine(startRow + rows + 1)
    const wrappedNext = !!next?.isWrapped
    text += cur.translateToString(!wrappedNext)
    rows += 1
    if (!wrappedNext) break
    cur = next
  }
  return { text, rows }
}

/** xterm link provider for file paths. Register once per (non-relay) terminal. */
export function createFileLinkProvider(term: Terminal, deps: FileLinkDeps): ILinkProvider {
  return {
    provideLinks(bufferLineNumber: number, callback: (links: ILink[] | undefined) => void): void {
      const startRow = bufferLineNumber - 1 // provider y is 1-based
      const logical = logicalLine(term, startRow)
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
          const endIndex = t.startIndex + t.text.length - 1
          return {
            text: t.text,
            range: {
              // ILink range coords are 1-based, inclusive.
              start: { x: (t.startIndex % cols) + 1, y: startRow + Math.floor(t.startIndex / cols) + 1 },
              end: { x: (endIndex % cols) + 1, y: startRow + Math.floor(endIndex / cols) + 1 }
            },
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
