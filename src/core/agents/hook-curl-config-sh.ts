/**
 * The one POSIX-sh helper every generated curl client uses to hand its credentials to curl.
 *
 * WHY IT EXISTS: a command line is not private. `ps` and `/proc/<pid>/cmdline` are world-readable
 * on a stock Linux, so `curl -H "X-Nodeterm-Node-Token: <token>"` publishes that token to every
 * other account on the machine for as long as the curl lives — locally AND on every SSH host,
 * where the hook clients are installed for remote agent nodes. The per-node token exists precisely
 * to answer "which node is calling?"; a co-tenant who scrapes one out of the process table can
 * impersonate that node, and the app-wide bearer alongside it is the key to the whole hook API.
 * So both headers are written into a curl config file on stdin (`--config -`) instead, the same
 * way `usage/remote-claude-usage.ts` and the codex launcher in `codex-identity-proxy.ts` already
 * do it. There is deliberately no argv fallback for an ancient curl: `--config` has been there
 * since the 1990s, and a silent downgrade to argv would be the leak wearing a compatibility hat.
 *
 * ONE COPY, THREE CLIENTS: the managed hook script, the canvas-control shim and the context-link
 * shim all send the same two headers. They used to carry three copies of the header lines; three
 * copies of an escaping rule is how one of them stays wrong.
 *
 * `nt_node_token` is the caller's variable (each client reads it from the token dir the endpoint
 * file advertises, keyed by its own node id) — it is read here, not passed, because the failover
 * in the managed script RE-READS it between POSTs and the helper must see the current value.
 */
export const HOOK_CURL_HEADERS_SH = `# Both credentials go to curl on STDIN as a config file, never in argv: a command line is
# world-readable through \`ps\` / /proc/<pid>/cmdline for the life of the process, locally and on
# every SSH host, so an argv header hands the app-wide bearer — and this node's own capability —
# to any co-tenant who looks at the process table. Reading another node's token out of \`ps\` is
# exactly the impersonation the per-node token exists to prevent.
#
# Quoting: a curl config file is LINE-based and its quoted values understand backslash escapes, so
# four characters could end a header line and start a directive of their own — \`"\`, \`\\\`, and the
# two line breaks. All four are stripped before the value is written. None can occur in a value we
# send today — the per-node token is kid.mac over [A-Za-z0-9._-] and the bearer is a UUID — which
# is what makes STRIPPING (rather than escaping) safe here: nothing legitimate is altered, and a
# value that somehow acquired one still could not break out of its own header line.
#
# An EMPTY value keeps the legacy contract exactly as \`-H\` did: curl sends no header at all when
# there is nothing after the colon, and the server reads absent and empty identically as \`legacy\`.
nt_hook_headers() {
  printf 'header = "X-Nodeterm-Hook-Token: %s"\\n' "$(printf %s "$NODETERM_HOOK_TOKEN" | tr -d '\\\\"\\n\\r')"
  printf 'header = "X-Nodeterm-Node-Token: %s"\\n' "$(printf %s "$nt_node_token" | tr -d '\\\\"\\n\\r')"
}`
