// Naming rules for a file pulled down from a remote host. Pure and shell-free so the SSH manager
// (and any later transport) share one answer, and so the awkward cases are testable.
//
// The remote name is the only attacker-influenced part of a download's LOCAL path: it comes off
// another machine's filesystem, and it ends up as a write target here. So it is basenamed and
// sanitized before it is joined to anything — never trusted as a path component on its own.
import path from 'node:path'

/**
 * The local filename for a remote path, or null when the remote path names nothing writable
 * (`/`, `.`, `..`, empty). Separators and control characters are replaced rather than rejected:
 * a name like `a\b.txt` is perfectly legal on the remote POSIX host but is a PATH on Windows,
 * and silently refusing the download would be worse than renaming it.
 */
export function safeDownloadBasename(remotePath: string): string | null {
  const base = path.posix.basename(remotePath.replace(/\/+$/, ''))
  if (!base || base === '.' || base === '..' || base === '~') return null
  // eslint-disable-next-line no-control-regex
  const safe = base.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').trim()
  return safe && safe !== '.' && safe !== '..' ? safe : null
}

/**
 * The n-th candidate name for a collision: `notes.md`, `notes (2).md`, `notes (3).md`. The counter
 * goes before the extension (Finder/Explorer convention) so the file still opens in the right app;
 * a dotfile (`.bashrc`) has no extension to speak of and takes the suffix at the end.
 */
export function candidateName(name: string, attempt: number): string {
  if (attempt <= 1) return name
  const dot = name.lastIndexOf('.')
  // `dot <= 0` covers both "no extension" and a leading-dot name like `.bashrc`.
  if (dot <= 0) return `${name} (${attempt})`
  return `${name.slice(0, dot)} (${attempt})${name.slice(dot)}`
}
