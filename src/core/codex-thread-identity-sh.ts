/**
 * POSIX-sh prelude prepended to every managed hook script.
 *
 * WHY IT EXISTS: with the shared app-server, the shell a Codex TOOL runs in is spawned by that
 * server, not by the TUI client NodeTerm launched. It therefore inherits `CODEX_THREAD_ID` but
 * none of the `NODETERM_*` env we set on the pane — so the hook it runs has no idea which canvas
 * node it belongs to, and the node's badge/status would simply never move. This recovers the node
 * binding from the thread id.
 *
 * The mapping file is parsed as DATA (`sed`), never sourced as shell code, and both recovered
 * fields are re-validated before they are exported. The record itself is HMAC-signed by
 * `codex-identity-proxy.ts`; this prelude cannot verify that signature (no key in an agent's
 * shell), which is why the charset re-validation below is not redundant.
 *
 * ACCOUNT SCOPING (S6): a SYSTEM record lives at the bare root (`<root>/<threadId>`) and a MANAGED
 * record under `<root>/<accountId>/<threadId>`. This prelude reads `NODETERM_CODEX_ACCOUNT_ID` from
 * the daemon's env to pick the scope:
 *   - a known, safe account id ⇒ read ONLY that account's record, and require the record's
 *     `accountId=` line to agree with the daemon scope;
 *   - an EMPTY account id (the classic shared tool shell that knows only a bare thread id) ⇒ scan
 *     EVERY scope (bare-root system + each managed subdir) and bind ONLY when exactly one candidate
 *     matches (`nt_codex_matches -eq 1`). Two accounts holding the same thread id ⇒ ambiguous ⇒
 *     change nothing (Property 3 / Constraint 8, the same fail-closed posture as the TypeScript
 *     `resolveCodexThreadNodeIdentity`).
 *
 * Inert for every other agent: without `CODEX_THREAD_ID` the whole block is skipped. A machine with
 * no managed accounts has no subdirs, so the scan reduces to the one bare-root read S4 did — the
 * legacy layout keeps resolving byte-for-byte (Constraint 12).
 *
 * Deliberately free of Node/Electron imports beyond the path it is given: the generated-script
 * cores are shared by the desktop and the Server Edition.
 */
import { posixQuote } from '../shared/ssh'

/**
 * PROBE U5 (Codex 0.146.0, 2026-08-19 — docs/superpowers/probes/2026-08-codex-tool-shell-env.md):
 * a shared `app-server`-spawned tool shell carries `CODEX_THREAD_ID` (measured — a fresh id per
 * thread) and NOT the per-pane `NODETERM_*` (the tool shell forks from the shared daemon, not the
 * connecting client; corroborated by the deployed S4 resolver that depends on exactly this). The
 * premise HOLDS, so the account-scoped scan below is warranted. Caveat: an in-process app-server
 * (`codex exec`) leaks `NODETERM_*`, but the outer `[ -z "$NODETERM_NODE_ID" ]` guard no-ops there.
 *
 * @param identityRoot absolute path of the thread → node record directory
 *   (`codexThreadIdentityRoot()`, i.e. under `CorePlatform.userDataDir` — NOT `~`).
 */
export function codexThreadIdentityResolverSh(identityRoot: string): string {
  return `# A shared-app-server Codex tool shell inherits CODEX_THREAD_ID, not the TUI client's
# NODETERM_* env. Recover this thread's exact node binding (account-scoped), or change nothing.
if [ -z "\${NODETERM_NODE_ID-}" ] && [ -n "\${CODEX_THREAD_ID-}" ]; then
  case "$CODEX_THREAD_ID" in
    # '.' and '..' MATCH the charset and are path segments: "$identityRoot"/.. is the record dir's
    # PARENT. Refused by name here for the same reason isSafeThreadId refuses them in TypeScript.
    ''|.|..|*[!A-Za-z0-9._-]*) ;;
    *)
      nt_codex_root=${posixQuote(identityRoot)}
      nt_codex_matches=0
      nt_codex_node=''
      nt_codex_endpoint=''
      # Validate one candidate record file for an expected scope, parsed as DATA. On success it
      # records the node/endpoint and counts the match. $1=file, $2=expected scope ('' = system).
      nt_codex_try() {
        [ -r "$1" ] || return 0
        nt_a=$(sed -n 's/^accountId=//p' "$1" | head -n 1)
        # The record's own account line must AGREE with the directory it was found in. A system
        # record's line is empty or the reserved word 'system'; a managed record's line is its id.
        case "$2" in
          '') case "$nt_a" in ''|system) ;; *) return 0 ;; esac ;;
          *) [ "$nt_a" = "$2" ] || return 0 ;;
        esac
        nt_n=$(sed -n 's/^nodeId=//p' "$1" | head -n 1)
        nt_e=$(sed -n 's/^endpoint=//p' "$1" | head -n 1)
        case "$nt_n" in ''|*[!A-Za-z0-9._-]*) return 0 ;; esac
        case "$nt_e" in /*) ;; *) return 0 ;; esac
        [ "$(printf %s "$nt_e" | tr -cd 'A-Za-z0-9._/ -')" = "$nt_e" ] || return 0
        nt_codex_node=$nt_n
        nt_codex_endpoint=$nt_e
        nt_codex_matches=$((nt_codex_matches + 1))
      }
      case "\${NODETERM_CODEX_ACCOUNT_ID-}" in
        '')
          # Unknown account: scan every scope, bind only if exactly one candidate matches.
          nt_codex_try "$nt_codex_root/$CODEX_THREAD_ID" ''
          for nt_codex_dir in "$nt_codex_root"/*/; do
            [ -d "$nt_codex_dir" ] || continue
            nt_codex_scope=\${nt_codex_dir%/}
            nt_codex_scope=\${nt_codex_scope##*/}
            case "$nt_codex_scope" in
              ''|.|..|system|*[!A-Za-z0-9._-]*) continue ;;
            esac
            nt_codex_try "$nt_codex_dir$CODEX_THREAD_ID" "$nt_codex_scope"
          done
          ;;
        # A daemon scope that could escape the mapping directory, or the reserved system word used
        # as a managed id: resolve nothing.
        .|..|system|*[!A-Za-z0-9._-]*) ;;
        *)
          nt_codex_try "$nt_codex_root/\${NODETERM_CODEX_ACCOUNT_ID}/$CODEX_THREAD_ID" \\
            "$NODETERM_CODEX_ACCOUNT_ID"
          ;;
      esac
      if [ "$nt_codex_matches" -eq 1 ] && [ -n "$nt_codex_node" ] && [ -n "$nt_codex_endpoint" ]
      then
        NODETERM_NODE_ID="$nt_codex_node"
        NODETERM_HOOK_ENDPOINT="$nt_codex_endpoint"
        NODETERM_AGENT_ID=codex
        NODETERM_CANVAS_CONTROL=1
        export NODETERM_NODE_ID NODETERM_HOOK_ENDPOINT NODETERM_AGENT_ID NODETERM_CANVAS_CONTROL
      fi
      ;;
  esac
fi`
}
