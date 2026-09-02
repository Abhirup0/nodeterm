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
/**
 * Does this command line already carry `flag` as an OPTION of its own?
 *
 * Issue #601: nodeterm appends its managed flags to a launch command it did not necessarily write —
 * `settings.agentLaunchCommands` lets the user replace the program part with a wrapper, and a
 * wrapper is entitled to spell an option nodeterm also spells. Appending blindly produced
 * `claude --permission-mode bypassPermissions --permission-mode auto`: a duplicate the field still
 * displayed as what the user typed, so whichever occurrence the CLI honoured, they had no way to
 * tell which.
 *
 * Both spellings count (`--flag value` and `--flag=value`), and the answer is computed from TOKENS
 * rather than from a substring search, which is the whole reason this lives beside `shellSplit`: an
 * override like `claude --append-system-prompt 'mind --permission-mode'` mentions the flag inside a
 * quoted argument, and a substring match there would suppress nodeterm's real flag over a sentence.
 *
 * Scanning stops at a bare `--`, because everything after end-of-options is a positional argument —
 * a word there is the CLI's data, not an option it will act on.
 */
export function argvHasFlag(cmd: string, flag: string): boolean {
  for (const token of shellSplit(cmd)) {
    if (token === '--') return false
    if (token === flag || token.startsWith(`${flag}=`)) return true
  }
  return false
}

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
