/**
 * A project's icon: an emoji, a curated lucide glyph, or a small raster image (GitHub avatar,
 * user upload, or a fetched favicon). Lives on `Project.icon` and rides `.nodeterm/project.json`
 * (git-shared) like `name`/`color`, so `sanitizeProjectIcon` treats every value as HOSTILE INPUT —
 * same stance as `readProjectCapabilities` / `validKanban` in core/workspace-files.ts: a stored
 * value survives only when it passes a strict check, everything else degrades to "no icon" rather
 * than throwing or rendering something unvetted (an oversized/foreign data: URL, an arbitrary
 * icon-font name that doesn't exist, an http(s) URL that would leak a referer on load).
 *
 * Browser-safe: this module is bundled into the renderer, so no node builtins (no `Buffer`).
 */
export type ProjectIcon =
  | { type: 'emoji'; emoji: string }
  | { type: 'lucide'; name: string }
  | { type: 'image'; src: string; source: 'github' | 'upload' | 'favicon' }

/**
 * Curated allowlist of lucide-react export ids (kebab-case) a project icon's `name` may be. Closed
 * set, not "any string lucide ships": an open set would let a hostile project.json name an icon
 * that doesn't exist in whatever lucide version this build carries, or churn every time lucide
 * renames one. Also drives the icon-picker grid (project-icons Task 4) — this list IS the grid.
 */
export const LUCIDE_ICON_IDS = [
  'folder', 'folder-git', 'code', 'terminal', 'rocket', 'box', 'package', 'database',
  'server', 'cloud', 'globe', 'star', 'heart', 'flag', 'bookmark', 'zap', 'flame', 'cpu',
  'layers', 'layout-grid', 'hash', 'braces', 'bug', 'wrench', 'hammer', 'beaker', 'palette',
  'paintbrush', 'camera', 'image', 'music', 'video', 'book', 'file-text', 'shield', 'key',
  'lock', 'users', 'bot', 'sparkles'
] as const

/**
 * Result of the main-process "pick a project icon image" flow (`shell.pickProjectIcon`): a re-
 * encoded PNG `data:` URL on success, an `error` message to surface, or `null` when the user
 * cancelled the file dialog. Shared so main, preload and the renderer agree on the shape.
 */
export type ProjectIconPickResult = { dataUrl: string } | { error: string } | null

/** MIME types an `image` icon's `data:` URL may declare. Closed set — no `image/svg+xml` (script
 *  execution risk on render), no video/other types. */
const IMAGE_ICON_MIME_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const

/** Decoded byte size cap for an `image` icon — keeps a hostile/careless project.json from
 *  embedding an arbitrarily large blob that then ships to every clone and re-renders on every load. */
export const PROJECT_ICON_MAX_BYTES = 262_144 // 256 KB

/**
 * Decoded byte length of a `data:` URL's payload; 0 for anything else (never throws). Only the
 * `;base64` form is sized precisely (arithmetic on the base64 string's length — `floor(len*3/4)`
 * minus padding — NOT `Buffer`, which does not exist in the renderer); a non-base64 (percent-
 * encoded) data URL is decoded and UTF-8-counted by hand for the same reason.
 */
export function dataUrlByteLength(dataUrl: string): number {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:')) return 0
  const comma = dataUrl.indexOf(',')
  if (comma === -1) return 0
  const header = dataUrl.slice(5, comma)
  const data = dataUrl.slice(comma + 1)
  if (!/;base64$/i.test(header)) {
    let decoded: string
    try {
      decoded = decodeURIComponent(data)
    } catch {
      return 0
    }
    let bytes = 0
    for (const ch of decoded) {
      const code = ch.codePointAt(0) ?? 0
      bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
    }
    return bytes
  }
  const clean = data.replace(/[^A-Za-z0-9+/=]/g, '')
  if (clean.length === 0) return 0
  const padding = clean.endsWith('==') ? 2 : clean.endsWith('=') ? 1 : 0
  return Math.floor((clean.length * 3) / 4) - padding
}

/**
 * Strict, throw-free normaliser for a value read as a project's `icon` — the boundary every
 * `project.json` (git-shared, hand-editable, auto-adopted) must cross. Unknown/malformed shapes,
 * an oversized or wrong-MIME image, an http(s)/non-`data:` `src`, or an unlisted lucide name all
 * degrade to `undefined` (no icon) rather than throwing or being trusted as-is.
 */
export function sanitizeProjectIcon(v: unknown): ProjectIcon | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  if (o.type === 'emoji') {
    return typeof o.emoji === 'string' && o.emoji.length > 0 && o.emoji.length <= 16
      ? { type: 'emoji', emoji: o.emoji }
      : undefined
  }
  if (o.type === 'lucide') {
    return typeof o.name === 'string' &&
      (LUCIDE_ICON_IDS as readonly string[]).includes(o.name)
      ? { type: 'lucide', name: o.name }
      : undefined
  }
  if (o.type === 'image') {
    if (typeof o.src !== 'string' || !o.src.startsWith('data:')) return undefined
    const mime = /^data:([^;,]*)/.exec(o.src)?.[1] ?? ''
    if (!(IMAGE_ICON_MIME_TYPES as readonly string[]).includes(mime)) return undefined
    if (dataUrlByteLength(o.src) > PROJECT_ICON_MAX_BYTES) return undefined
    if (o.source !== 'github' && o.source !== 'upload' && o.source !== 'favicon') return undefined
    return { type: 'image', src: o.src, source: o.source }
  }
  return undefined
}
