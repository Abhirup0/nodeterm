// Shared terminal file-drop/paste logic — used by both the canvas TerminalNode and the kanban card
// modal's co-attach terminal (ModalTerminal), so a file dropped onto or pasted into either becomes
// a path the same way.

/** Backslash-escape shell-special characters, like a native terminal does on file drop. */
export function escapeDroppedPath(p: string): string {
  return p.replace(/([ \t"'`\\()&;|<>$!*?[\]{}#~])/g, '\\$1')
}

/** Extension for a clipboard blob that arrives with no filename, keyed off its MIME type. A
 *  screenshot is `image/png` with an empty `name`, and an agent asked to look at `pasted-<ts>`
 *  with no suffix has to guess what it is holding. */
const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tiff',
  'application/pdf': 'pdf',
  'text/plain': 'txt'
}

/** The name to store a file under. Clipboard bytes usually have none, so one is generated from
 *  the MIME type + a timestamp — recognizable in a prompt and unique enough to read back. */
export function uploadNameFor(file: File): string {
  if (file.name) return file.name
  const ext = EXT_BY_TYPE[file.type] ?? (file.type.split('/')[1] || 'bin')
  const stamp = new Date()
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\..+$/, '')
    .replace('T', '-')
  return `pasted-${stamp}.${ext}`
}

/** Files carried by a paste. Chromium exposes an OS file-manager copy on `files`, and raw
 *  clipboard bytes (a screenshot) as an `items` entry of kind 'file' — read both, since a paste
 *  that carries neither must fall through to xterm as ordinary text. */
export function pastedFiles(dt: DataTransfer | null): File[] {
  if (!dt) return []
  const files = Array.from(dt.files)
  if (files.length) return files
  return Array.from(dt.items)
    .filter((it) => it.kind === 'file')
    .map((it) => it.getAsFile())
    .filter((f): f is File => !!f)
}

const readAsBase64 = (file: File): Promise<string | null> =>
  new Promise((resolve) => {
    const reader = new FileReader()
    reader.onerror = () => resolve(null)
    reader.onload = () => {
      const res = typeof reader.result === 'string' ? reader.result : ''
      const comma = res.indexOf(',')
      resolve(comma >= 0 ? res.slice(comma + 1) : null)
    }
    reader.readAsDataURL(file)
  })

/**
 * The file's path ON THE MACHINE THE TERMINAL RUNS ON.
 *
 * A desktop drag-drop already has one (Electron can name the OS file), and using it copies
 * nothing. Everything else has bytes and no usable path — clipboard images have never been a file
 * anywhere, and a browser client's file lives on a different machine entirely — so the bytes are
 * written into the managed uploads dir over there and THAT path is what the terminal gets.
 */
async function localPathFor(file: File): Promise<string | null> {
  const direct = window.nodeTerminal.getPathForFile(file)
  if (direct) return direct
  const data = await readAsBase64(file)
  if (!data) return null
  return window.nodeTerminal.files.saveUpload(uploadNameFor(file), data).catch(() => null)
}

/**
 * Resolve dropped/pasted files to terminal-pasteable paths. For an SSH-project terminal a local
 * path is useless on the host, so each file is uploaded over the project's ControlMaster and its
 * REMOTE absolute path is returned; for a local terminal the local path is used. Fail-open: files
 * that can't be resolved/uploaded are dropped from the result (never throws).
 */
export async function droppedPaths(
  files: File[],
  opts: { sshRemoteTmux: boolean; projectId: string }
): Promise<string[]> {
  const local = await Promise.all(files.map((f) => localPathFor(f).catch(() => null)))
  const pairs = files
    .map((f, i) => ({ file: f, path: local[i] }))
    .filter((p): p is { file: File; path: string } => !!p.path)
  if (!opts.sshRemoteTmux) return pairs.map((p) => escapeDroppedPath(p.path))
  const uploaded = await Promise.all(
    pairs.map((p) =>
      window.nodeTerminal.sshProject
        .uploadFile(opts.projectId, p.path, uploadNameFor(p.file))
        .catch(() => null)
    )
  )
  return uploaded.filter((p): p is string => !!p).map(escapeDroppedPath)
}
