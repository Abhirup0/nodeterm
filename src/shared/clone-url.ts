// Pure helpers for the clone-repo flow. No electron/node imports — shared by the
// renderer dialog (live validation/preview) and the main process (authoritative checks).

export interface CloneProgress {
  phase: string
  percent: number
}

/** `owner/repo` GitHub shorthand → HTTPS clone URL. Anything else passes through. */
export function expandCloneUrl(input: string): string {
  const s = input.trim()
  const m = s.match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/)
  if (m && !s.startsWith('-')) {
    return `https://github.com/${m[1]}/${m[2].replace(/\.git$/i, '')}.git`
  }
  return s
}

/**
 * Validate a clone URL: must use a known scheme (or scp-style git@host:path) and
 * must not begin with `-`, so it can't be parsed by git as an option flag
 * (e.g. `--upload-pack=…`, which is a remote-code-execution vector).
 */
export function isValidCloneUrl(url: string): boolean {
  const u = url.trim()
  if (!u || u.startsWith('-')) return false
  return /^(https?:\/\/|ssh:\/\/|git:\/\/|git@[^/]+:)/.test(u)
}

/**
 * The folder name `git clone` would create for this URL. Returns null for names that
 * are empty/`.`/`..` or contain path separators — a crafted URL must never be able to
 * write outside (or delete) the parent directory.
 */
export function deriveRepoDirName(url: string): string | null {
  const trimmed = url.trim().replace(/\/+$/, '').replace(/\.git$/i, '')
  const base = trimmed.split(/[/:\\]/).pop() ?? ''
  if (!base || base === '.' || base === '..') return null
  return base
}

/** Last `<phase>:  NN%` line in a stderr chunk (git overwrites lines with \r). */
export function parseCloneProgress(chunk: string): CloneProgress | null {
  let out: CloneProgress | null = null
  for (const line of chunk.split(/[\r\n]+/)) {
    const m = line.match(/([A-Za-z][A-Za-z\s-]*):\s+(\d+)%/)
    if (m) out = { phase: m[1].trim(), percent: Math.min(100, parseInt(m[2], 10)) }
  }
  return out
}

/** Remove ANSI SGR sequences (git colorizes fatal lines on some setups). */
export function stripAnsiCodes(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1b\[[0-9;]*m/g, '')
}
