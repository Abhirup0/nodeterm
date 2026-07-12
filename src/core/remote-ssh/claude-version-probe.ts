// Pure shell command + parser for the REMOTE `claude --version` probe.
//
// The probe has to run through the LOGIN shell (`$SHELL -lc`): an ssh exec channel gets a
// non-interactive, non-login shell whose rc file usually bails out early, so a claude installed via
// nvm/asdf/homebrew can be invisible to a bare `claude --version`. But a login shell SOURCES the
// user's profile, and profiles print to STDOUT — corp banners, `neofetch`, `echo "kernel $(uname
// -r)"`, pyenv/conda notices. Every version check in the app first-matches a `\d+\.\d+\.\d+`
// anywhere in the string, so a banner line like `Welcome — Ubuntu 22.04.3 LTS` would be read as
// "claude 22.04.3" → "new enough for --permission-mode auto" → every Claude node in that project
// launches a flag its 2.0.x CLI rejects with exit 1 (dead node).
//
// So the value is DELIMITED, exactly like the login-shell PATH probe in `core/pty-manager.ts`
// (`__NT_PATH_START__`/`__NT_PATH_END__`): print it between markers and read only what sits between
// them. No markers ⇒ the probe FAILED (⇒ unknown version ⇒ no flag), never "modern CLI".
import { posixQuote } from '../../shared/ssh'

export const CLAUDE_VERSION_START = '__NT_V_START__'
export const CLAUDE_VERSION_END = '__NT_V_END__'

/**
 * The remote shell command that prints `claude --version` between the markers, or nothing.
 * Login shell first, plain exec shell as the fallback (some hosts have no usable `$SHELL -l`).
 */
export function claudeVersionProbeCommand(): string {
  // `[ -n "$v" ]` keeps the exit code non-zero when claude is missing or prints nothing, so the
  // `||` fallback still gets its turn — the same two-step lookup as before the markers.
  const emit =
    `v=$(claude --version 2>/dev/null) && [ -n "$v" ] && ` +
    `printf '${CLAUDE_VERSION_START}%s${CLAUDE_VERSION_END}' "$v"`
  const q = posixQuote(emit)
  return `$SHELL -lc ${q} 2>/dev/null || sh -c ${q} 2>/dev/null`
}

/**
 * The version string between the markers, or null when they're absent/empty — i.e. the probe
 * failed. Profile noise printed before/after the markers is discarded, so it can never be parsed
 * as the CLI's version.
 */
export function parseClaudeVersionProbe(stdout: string | null | undefined): string | null {
  if (!stdout) return null
  const start = stdout.indexOf(CLAUDE_VERSION_START)
  if (start < 0) return null
  const from = start + CLAUDE_VERSION_START.length
  const end = stdout.indexOf(CLAUDE_VERSION_END, from)
  if (end < 0) return null
  return stdout.slice(from, end).trim() || null
}
