// Size guard for whole-file IPC reads (fs:read / fs:read-binary). The payload is loaded fully
// in the main process, then structured-cloned across to the renderer — an unbounded read of a
// huge file (a giant log, a video accidentally opened as text) spikes memory in BOTH processes
// in one shot. Reads above the cap return a sentinel string instead of content; it starts with
// a NUL byte, which no valid text/base64 payload can, so consumers can distinguish it cheaply
// and show "file too large" — critically, the editor must NOT open an empty buffer for such a
// file (saving it would truncate the real file).
export const FS_READ_MAX_BYTES = 10 * 1024 * 1024
export const FS_READ_BINARY_MAX_BYTES = 24 * 1024 * 1024

const TOO_LARGE_PREFIX = '\u0000nodeterm:too-large:'

export function tooLargeSentinel(sizeBytes: number): string {
  return `${TOO_LARGE_PREFIX}${sizeBytes}`
}

/** The file's byte size if `s` is a too-large sentinel, else null. */
export function tooLargeSize(s: string): number | null {
  if (!s.startsWith(TOO_LARGE_PREFIX)) return null
  const n = Number(s.slice(TOO_LARGE_PREFIX.length))
  return Number.isFinite(n) ? n : null
}

export function formatBytes(n: number): string {
  if (n >= 1024 * 1024 * 1024) return `${(n / (1024 * 1024 * 1024)).toFixed(1)} GB`
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`
  if (n >= 1024) return `${Math.round(n / 1024)} KB`
  return `${n} B`
}
