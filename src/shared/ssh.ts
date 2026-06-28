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

/** Single-quote a string for use as ONE POSIX shell token (safe inside a remote command). */
export function posixQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

/**
 * Quote a remote path as one shell token, but leave a leading `~` / `~/` UNQUOTED so the remote
 * shell tilde-expands it (single quotes suppress `~` expansion). The remainder stays quoted, so a
 * directory name can never inject shell. `~` alone → `~`; `~/a b` → `~/'a b'`; `/srv/x` → `'/srv/x'`.
 */
export function quoteRemotePath(p: string): string {
  if (p === '~') return '~'
  if (p.startsWith('~/')) return p.length > 2 ? `~/${posixQuote(p.slice(2))}` : '~/'
  return posixQuote(p)
}

/** Build the remote shell command that attaches-or-creates this node's remote tmux session. */
export function remoteTmuxCommand(opts: {
  sessionId: string
  remoteCwd: string
  program?: string
  programArgs?: string[]
  socket?: string
}): string {
  const socket = opts.socket ?? 'nodeterm-rmt'
  const parts = [
    'tmux',
    '-L',
    socket,
    'new-session',
    '-A',
    '-s',
    posixQuote(opts.sessionId),
    '-c',
    quoteRemotePath(opts.remoteCwd)
  ]
  if (opts.program) {
    parts.push(posixQuote(opts.program))
    for (const a of opts.programArgs ?? []) parts.push(posixQuote(a))
  }
  return parts.join(' ')
}

/** Parse `ls -1Ap <dir>` output into sorted directory names (trailing `/`), excluding . and .. */
export function parseLsDirs(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.endsWith('/') && l !== './' && l !== '../')
    .map((l) => l.slice(0, -1))
    .sort((a, b) => a.localeCompare(b))
}

/** A host parsed from `~/.ssh/config`, ready to seed a saved server (no id yet). */
export interface ParsedSshHost {
  /** The `Host` alias (display label). */
  label: string
  /** `HostName` if set, else the alias. */
  host: string
  user?: string
  port?: number
  identityFile?: string
}

/**
 * Parse `~/.ssh/config` text into named hosts. Each non-wildcard `Host` alias becomes one
 * entry, taking the block's `HostName`/`User`/`Port`/`IdentityFile`. Wildcard aliases
 * (containing `*` or `?`) and the bare `Host *` catch-all are skipped — they aren't concrete
 * servers. Keys are case-insensitive; `key=value` and `key value` forms are both accepted.
 */
export function parseSshConfig(text: string): ParsedSshHost[] {
  const hosts: ParsedSshHost[] = []
  // Aliases sharing one `Host` line all receive the block's settings.
  let current: { aliases: string[]; settings: Record<string, string> } | null = null

  const flush = () => {
    if (!current) return
    for (const alias of current.aliases) {
      if (alias.includes('*') || alias.includes('?')) continue
      const s = current.settings
      const port = s.port ? Number(s.port) : undefined
      hosts.push({
        label: alias,
        host: s.hostname || alias,
        user: s.user || undefined,
        port: Number.isFinite(port) ? port : undefined,
        identityFile: s.identityfile || undefined
      })
    }
    current = null
  }

  for (const raw of text.split('\n')) {
    const line = raw.replace(/#.*$/, '').trim()
    if (!line) continue
    const eq = line.indexOf('=')
    const sp = line.search(/\s/)
    let key: string
    let value: string
    if (eq !== -1 && (sp === -1 || eq < sp)) {
      key = line.slice(0, eq).trim()
      value = line.slice(eq + 1).trim()
    } else if (sp !== -1) {
      key = line.slice(0, sp).trim()
      value = line.slice(sp + 1).trim()
    } else {
      key = line
      value = ''
    }
    const lkey = key.toLowerCase()
    if (lkey === 'host') {
      flush()
      current = { aliases: value.split(/\s+/).filter(Boolean), settings: {} }
    } else if (current) {
      current.settings[lkey] = value
    }
  }
  flush()
  return hosts
}
