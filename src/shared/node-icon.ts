/**
 * A canvas node's user-chosen icon: one emoji/character, or a small image file.
 *
 * The value is persisted in `.nodeterm/project.json`, which is git-shared, hand-editable and —
 * for an SSH project — a file on the remote host. So nothing here trusts its input: every value
 * that reaches a render or a filesystem read goes through `normalizeNodeIcon` FIRST, at the point
 * of use, exactly as `permissionModeFlag` re-validates a permission mode and `safeSessionProgram`
 * re-validates a session program. The TypeScript type is a compile-time claim about our own
 * writers; it says nothing about a file someone cloned.
 *
 * Three rules, and each one is the answer to a specific way this could go wrong:
 *
 *  1. **An emoji is ONE grapheme.** Without a cap, `"icon": {"type":"emoji","value":"<40kB>"}`
 *     in a shared project file is a blob rendered into every node header, every kanban card and
 *     every sidebar row. Truncating is safe (the user sees a shorter icon than they typed);
 *     refusing outright would drop a perfectly good four-person ZWJ family emoji, which is 11
 *     UTF-16 units and would fail any naive length check.
 *
 *  2. **An image path must LOOK like an image.** The extension gate is what stops a hostile
 *     project.json from aiming `fs.readBinary` at `~/.ssh/id_rsa`. It is not a complete jail —
 *     the file can still name any *.png on the machine, exactly as an editor node's `filePath`
 *     always could — but the bytes only ever become an `<img>` in a renderer with a `'self'` CSP
 *     and no network, so the reachable outcome is "an icon fails to draw", not exfiltration.
 *
 *  3. **A relative path may not traverse.** `./` paths are resolved against the project cwd (see
 *     below), so a `./..`-prefixed one would walk straight out of the project. Same rule, and the
 *     same reasoning, as `isSafeQuickOpenRelPath` on the remote quick-open index.
 *
 * **Portability.** An icon image lives beside the canvas that names it, in the project's own
 * git-shared `.nodeterm/images/` (see core/canvas-images.ts). A path stored absolutely would
 * therefore travel to a teammate as a path only the author's machine has — the file arrives, the
 * icon does not. So a path under the project cwd is stored `./`-relative and resolved on read,
 * which is the convention `toPortableNodes` already established for node cwds. Everything else
 * (a cwd-less canvas, an SSH project, the app-local fallback `saveCanvasImage` takes when the
 * project folder will not accept the write) stays absolute and simply does not travel — the same
 * degrade canvas image nodes take, and not an error.
 */

/** Extensions an icon image may have, mapped to the MIME type its data URL is built with. */
export const NODE_ICON_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
  avif: 'image/avif'
}

/** A node's icon: one emoji/character, or an image file beside the project. */
export type NodeIcon =
  | { type: 'emoji'; value: string }
  | { type: 'image'; path: string }

/**
 * Hard ceiling on an emoji's UTF-16 length, applied when `Intl.Segmenter` is unavailable so the
 * grapheme walk below cannot be the only thing standing between a shared file and a blob. Sized
 * to fit the longest emoji anyone actually types: a four-person ZWJ family is 11 units, a flag
 * sequence with modifiers a little more.
 */
const EMOJI_MAX_UNITS = 24

/**
 * Control characters (C0 + DEL) are matched by code point rather than by a regex character class,
 * so this file stays pure ASCII and no tool between here and the repo can mangle the range.
 */
const isControlCodePoint = (cp: number): boolean => cp < 0x20 || cp === 0x7f

const stripControl = (s: string): string =>
  Array.from(s)
    .filter((ch) => !isControlCodePoint(ch.codePointAt(0) ?? 0))
    .join('')

const hasControl = (s: string): boolean =>
  Array.from(s).some((ch) => isControlCodePoint(ch.codePointAt(0) ?? 0))

interface GraphemeSegmenter {
  segment(input: string): Iterable<{ segment: string }>
}

/** The MIME type for an icon image path, or undefined when the extension is not an image one. */
export function nodeIconMime(path: string): string | undefined {
  const name = path.split('/').pop() ?? ''
  // A name with no dot has no extension: `.split('.').pop()` would return the whole name, so
  // `README` would resolve as an extension and only miss by luck.
  if (!name.includes('.')) return undefined
  return NODE_ICON_MIME[name.split('.').pop()!.toLowerCase()]
}

/**
 * The first grapheme cluster of `raw`, with control characters (including the newlines a paste
 * can carry) removed first. `Intl.Segmenter` is the correct tool and is present in both shells'
 * runtimes; the length cap is the fallback for a runtime without it, never the primary rule —
 * slicing UTF-16 units would cut a ZWJ sequence in half and render a fragment.
 */
function firstGrapheme(raw: string): string {
  const clean = stripControl(raw).trim()
  if (!clean) return ''
  const ctor = (
    Intl as unknown as {
      Segmenter?: new (locale?: string, options?: { granularity: string }) => GraphemeSegmenter
    }
  ).Segmenter
  if (ctor) {
    for (const s of new ctor(undefined, { granularity: 'grapheme' }).segment(clean)) return s.segment
    return ''
  }
  return clean.slice(0, EMOJI_MAX_UNITS)
}

/** True when a `./`-relative icon path stays inside the project root. */
function isSafeRelIconPath(rel: string): boolean {
  return rel.split('/').every((seg) => seg !== '' && seg !== '..' && seg !== '.')
}

/**
 * Validate an icon value read from a persisted (hostile) source. Returns the value to use, or
 * **undefined** — which renders as no icon at all, i.e. the pre-feature node. Never throws, and
 * never substitutes a nearest match: an unrecognized icon is no icon.
 */
export function normalizeNodeIcon(raw: unknown): NodeIcon | undefined {
  if (!raw || typeof raw !== 'object') return undefined
  const v = raw as { type?: unknown; value?: unknown; path?: unknown }
  if (v.type === 'emoji') {
    if (typeof v.value !== 'string') return undefined
    const value = firstGrapheme(v.value)
    return value ? { type: 'emoji', value } : undefined
  }
  if (v.type === 'image') {
    if (typeof v.path !== 'string') return undefined
    const path = v.path.trim()
    if (!path || hasControl(path) || !nodeIconMime(path)) return undefined
    if (path.startsWith('./')) {
      return isSafeRelIconPath(path.slice(2)) ? { type: 'image', path } : undefined
    }
    // Anything else must be an absolute POSIX path: a bare `foo.png` has no root to resolve
    // against, and resolving it against the cwd of whatever process happens to be running is
    // precisely the kind of guess this module refuses to make.
    return path.startsWith('/') ? { type: 'image', path } : undefined
  }
  return undefined
}

/**
 * How an absolute image path is STORED on a node: `./`-relative when it sits inside the project's
 * own folder (so it travels with the repo), absolute otherwise. `projectCwd` is undefined for a
 * cwd-less canvas and for an SSH project, where the image is written app-locally.
 */
export function portableIconPath(absPath: string, projectCwd?: string): string {
  if (!projectCwd) return absPath
  const root = projectCwd.replace(/\/+$/, '')
  if (!root || !absPath.startsWith(`${root}/`)) return absPath
  const rel = absPath.slice(root.length + 1)
  return rel && isSafeRelIconPath(rel) ? `./${rel}` : absPath
}

/**
 * The absolute path to read an icon image from, or undefined when it cannot be resolved — a
 * `./` path on a project that has no local cwd (it was written by a machine that did). Undefined
 * means the icon does not draw; it must never mean "read something else".
 */
export function resolveIconPath(storedPath: string, projectCwd?: string): string | undefined {
  if (!storedPath.startsWith('./')) return storedPath.startsWith('/') ? storedPath : undefined
  const rel = storedPath.slice(2)
  if (!isSafeRelIconPath(rel)) return undefined
  const root = projectCwd?.replace(/\/+$/, '')
  return root ? `${root}/${rel}` : undefined
}
