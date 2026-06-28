import fs from 'fs'
import path from 'path'
import { createHash } from 'crypto'
import { app } from 'electron'

// On a machine reboot the tmux server dies, so the live scrollback is lost. We persist a
// byte-capped snapshot of each terminal's recent output to disk while it's running and replay
// it into xterm on a cold restart, so the user sees where they left off (a cold
// restore). Warm reattach (app restart, tmux alive) ignores the snapshot — tmux redraws.

const DIR_NAME = 'terminal-scrollback'
// Trailing bytes we keep / replay. Enough for a few screens of context without bloating disk
// or stalling the renderer on replay.
const MAX_BYTES = 256 * 1024

function dir(): string {
  return path.join(app.getPath('userData'), DIR_NAME)
}

// persistKey is a node id (uuid-ish) but may contain arbitrary characters; hash it to a safe,
// fixed-length filename.
function snapshotPath(persistKey: string): string {
  const hash = createHash('sha256').update(persistKey).digest('hex').slice(0, 32)
  return path.join(dir(), `${hash}.bin`)
}

/** Keep only the trailing `MAX_BYTES`, not splitting a UTF-8 sequence at the cut point. */
function trailing(data: string): Buffer {
  const bytes = Buffer.from(data, 'utf-8')
  if (bytes.length <= MAX_BYTES) return bytes
  let start = bytes.length - MAX_BYTES
  // advance past any continuation bytes (0b10xxxxxx) so we start on a code-point boundary
  while (start < bytes.length && (bytes[start] & 0xc0) === 0x80) start++
  return bytes.subarray(start)
}

export function writeScrollback(persistKey: string, data: string): void {
  if (!data) return
  try {
    fs.mkdirSync(dir(), { recursive: true })
    const file = snapshotPath(persistKey)
    const tmp = `${file}.tmp`
    fs.writeFileSync(tmp, trailing(data))
    fs.renameSync(tmp, file)
  } catch {
    // best-effort: a failed snapshot just means no cold-restore replay for this node
  }
}

export function readScrollback(persistKey: string): string {
  try {
    return fs.readFileSync(snapshotPath(persistKey), 'utf-8')
  } catch {
    return ''
  }
}

export function deleteScrollback(persistKey: string): void {
  try {
    fs.rmSync(snapshotPath(persistKey), { force: true })
  } catch {
    // ignore
  }
}
