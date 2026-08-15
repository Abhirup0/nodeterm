/** Single-quote a string for safe use as one shell argument (POSIX).
 *
 *  Lives in `src/shared` so both the renderer's command assembly and any main/server-side
 *  command builder share one definition — a second copy would drift the quoting and let an
 *  unescaped quote reach a tmux `send-keys` line. */
export function shellSingleQuote(s: string): string {
  // POSIX single-quote: wrap in single quotes, and replace each embedded single quote with the
  // close-quote/escaped-quote/reopen-quote sequence `'\''`. Plain concatenation (not a template
  // literal) on purpose — a nested-backtick template for the replacement is legal but fragile
  // under tooling, and this is the one function whose correctness every typed command depends on.
  return "'" + s.replace(/'/g, "'\\''") + "'"
}

/** Tokens made only of these characters mean the same thing bare and quoted, so they may pass
 *  through unquoted — which keeps an unexpanded `claude --resume` byte-identical to what the
 *  historical builder typed. Everything else (whitespace, quotes, `;`, `$`, backticks, globs…)
 *  gets the single-quote treatment. */
const SAFE_BARE_TOKEN = /^[A-Za-z0-9_@%+=:,.^/-]+$/

/** Quote `s` as one shell argument ONLY if it needs it. The quote-by-construction half of env
 *  expansion: an expanded value that is shell-inert stays bare (so builtin commands don't churn),
 *  and anything that could read as shell syntax is fenced into a literal. */
export function shellQuoteIfNeeded(s: string): string {
  return s !== '' && SAFE_BARE_TOKEN.test(s) ? s : shellSingleQuote(s)
}

/**
 * Split a free-text argv string into tokens the way a POSIX shell would, honoring single and
 * double quotes and backslash escapes. Used for a custom agent's `args` field, which the user
 * types as one string (matching `launchCmd`) but which must become discrete argv before the prompt
 * is appended.
 *
 * Deliberately NOT a full shell: no variable expansion, no command substitution, no tilde. The
 * expansion that DOES happen (`${env:VAR}`) is nodeterm's own, run PER TOKEN after this split
 * (see launch.ts), so a resolved value containing spaces or metacharacters stays one argument by
 * construction — the token boundary is fixed before any environment value enters the string.
 */
export function shellSplit(input: string): string[] {
  const tokens: string[] = []
  let buf = ''
  let i = 0
  let inSingle = false
  let inDouble = false
  let hasToken = false
  const push = () => {
    if (hasToken) tokens.push(buf)
    buf = ''
    hasToken = false
  }
  while (i < input.length) {
    const c = input[i]
    if (inSingle) {
      if (c === "'") inSingle = false
      else buf += c
    } else if (inDouble) {
      if (c === '\\' && input[i + 1] !== undefined) {
        buf += input[i + 1]
        i++
      } else if (c === '"') {
        inDouble = false
      } else {
        buf += c
      }
    } else if (c === '\\' && input[i + 1] !== undefined) {
      buf += input[i + 1]
      hasToken = true
      i++
    } else if (c === "'") {
      inSingle = true
      hasToken = true
    } else if (c === '"') {
      inDouble = true
      hasToken = true
    } else if (/\s/.test(c)) {
      push()
    } else {
      buf += c
      hasToken = true
    }
    i++
  }
  push()
  return tokens
}
