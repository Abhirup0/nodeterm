/**
 * TS-side parser for the endpoint env file (`hook-endpoint.env` / `hook-endpoint-<project>.env`).
 *
 * Since #351 both writers `posixQuote` every value so the file sources cleanly under /bin/sh when
 * a path carries a space (macOS "Application Support") or a token carries a shell metachar. Shell
 * consumers get the unquoting for free from `. "$file"`; every TypeScript consumer must unquote
 * through THIS function instead of splitting on `=` naively — a naive read keeps the literal
 * quote characters, which breaks the constant-time bearer check (opencode plugin) and turns
 * `Number("'54321'")` into NaN (codex relay daemon).
 *
 * Accepts BOTH forms per line, so one parser covers the whole fleet:
 *  - quoted (post-#351): `KEY='value'`, with embedded single quotes escaped exactly as
 *    `posixQuote` emits them (`'` → `'\''`);
 *  - legacy unquoted (pre-fix builds): `KEY=value` verbatim. tmux sessions outlive the app, so a
 *    stale endpoint file written by an old build is a real, documented state — it must keep
 *    parsing.
 *
 * SELF-CONTAINED ON PURPOSE — no imports, no closure over module state. The opencode plugin is
 * generated JS source that runs standalone under Bun/node (it cannot import from this app), so
 * `buildOpencodePlugin()` embeds this very function via `parseEndpointEnv.toString()`. Keep it
 * dependency-free (and free of template literals / `${`) or the embedded copy breaks.
 */
export function parseEndpointEnv(text: string): Record<string, string> {
  const env: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const i = line.indexOf('=')
    if (i <= 0) continue
    let v = line.slice(i + 1)
    if (v.length >= 2 && v.charAt(0) === "'" && v.charAt(v.length - 1) === "'") {
      // posixQuote form: strip the outer quotes, then collapse each embedded-quote escape
      // ('\'' — close quote, escaped quote, reopen quote) back to a literal quote.
      v = v.slice(1, -1).split("'\\''").join("'")
    }
    env[line.slice(0, i)] = v
  }
  return env
}
