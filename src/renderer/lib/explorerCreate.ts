// Pure path logic for Explorer/canvas "New File…" / "New Folder…" — kept out of the
// components so name validation and expansion targets are unit-testable. Paths are
// `/`-separated absolutes (remote SSH paths included); names come from a user prompt.

/** The directory a create targets: the clicked dir itself, or the clicked file's parent. */
export function createTargetDir(path: string, isDir: boolean): string {
  return isDir ? path : parentDir(path)
}

export function parentDir(p: string): string {
  const i = p.replace(/\/+$/, '').lastIndexOf('/')
  return i <= 0 ? '/' : p.slice(0, i)
}

/**
 * Join a user-entered name onto a base dir. Multi-segment relative names (`a/b.ts`) are
 * allowed — intermediate dirs are the caller's job (see `ancestorDirs`). Returns null for
 * anything unsafe or senseless: empty, absolute, `..` traversal, trailing slash.
 */
export function newEntryPath(baseDir: string, name: string): string | null {
  const n = name.trim()
  if (!n || n.startsWith('/') || n.endsWith('/')) return null
  if (n.split('/').some((seg) => !seg || seg === '..')) return null
  return `${baseDir.replace(/\/+$/, '')}/${n}`
}

/** Absolute paths of the intermediate dirs a nested name passes through (shallowest first). */
export function ancestorDirs(baseDir: string, name: string): string[] {
  const segs = name.trim().split('/').slice(0, -1)
  const out: string[] = []
  let acc = baseDir.replace(/\/+$/, '')
  for (const s of segs) {
    acc = `${acc}/${s}`
    out.push(acc)
  }
  return out
}
