/**
 * Pure helpers for launching the system `ssh` binary as a terminal session program.
 * No Electron, no node-pty — unit-testable in isolation.
 */

/** A single SSH connection's parameters (inline-persisted on a node as `data.ssh`). */
export interface SshConnection {
  host: string
  user: string
  /** Defaults to 22. */
  port?: number
  /** Optional `-i` identity file path. */
  identityFile?: string
  /** Optional raw extra ssh args (advanced), POSIX-tokenized. */
  extraArgs?: string
  /** Display label, copied from the saved server when the node is created. */
  label?: string
}

/** A saved server in the app's SSH store. `label` is required for display. */
export interface SshServer extends SshConnection {
  id: string
  label: string
}

/**
 * Split a raw extra-args string into argv tokens, honoring single and double quotes.
 * Unquoted whitespace separates tokens; quotes group; quote chars are stripped.
 */
export function parseExtraArgs(s: string | undefined): string[] {
  if (!s || !s.trim()) return []
  const tokens: string[] = []
  let cur = ''
  let quote: '"' | "'" | null = null
  let has = false
  for (const ch of s) {
    if (quote) {
      if (ch === quote) quote = null
      else cur += ch
    } else if (ch === '"' || ch === "'") {
      quote = ch
      has = true
    } else if (/\s/.test(ch)) {
      if (has) tokens.push(cur)
      cur = ''
      has = false
    } else {
      cur += ch
      has = true
    }
  }
  if (has) tokens.push(cur)
  return tokens
}

/** Build the `ssh` argv: `-p <port> [-i <id>] [...extra] user@host`. */
export function buildSshArgs(conn: SshConnection): string[] {
  const args = ['-p', String(conn.port ?? 22)]
  if (conn.identityFile) args.push('-i', conn.identityFile)
  args.push(...parseExtraArgs(conn.extraArgs))
  args.push(`${conn.user}@${conn.host}`)
  return args
}
