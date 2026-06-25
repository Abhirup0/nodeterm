/** Decides whether a quick-open file should open as an editor node (text/image, handled by
 *  EditorNode) or be handed to the OS default app (binaries/installers like .dmg). */

// Extensions the OS should handle — EditorNode (Monaco) can't render these. Anything NOT in
// this set opens in an editor node (text, code, images, or extensionless config files).
const OS_OPEN_EXTENSIONS = new Set([
  'dmg', 'pkg', 'app', 'zip', 'gz', 'tar', 'tgz', 'rar', '7z',
  'exe', 'msi', 'deb', 'rpm', 'iso',
  'mp4', 'mov', 'avi', 'mkv', 'mp3', 'wav', 'flac',
  'sqlite', 'db', 'bin', 'dat', 'wasm'
])

/** Returns the lowercase extension of a single path segment, or '' if it has none. */
function extensionOf(segment: string): string {
  const dot = segment.lastIndexOf('.')
  if (dot <= 0) return ''
  return segment.slice(dot + 1).toLowerCase()
}

export function opensInEditor(path: string): boolean {
  const segments = path.replace(/\\/g, '/').split('/').filter(Boolean)
  if (segments.length === 0) return true
  // A file living inside an OS bundle/archive (e.g. "App.app/Contents/Info") must go to the OS,
  // so inspect every segment — not just the basename.
  for (const segment of segments) {
    if (OS_OPEN_EXTENSIONS.has(extensionOf(segment))) return false
  }
  return true
}
