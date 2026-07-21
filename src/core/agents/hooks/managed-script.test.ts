import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { buildManagedScript } from './managed-script'

describe('buildManagedScript', () => {
  const s = buildManagedScript('claude')
  it('keeps the local TCP POST path', () => {
    expect(s).toContain('http://127.0.0.1:${NODETERM_HOOK_PORT}/hook/claude')
  })
  it('adds a unix-socket POST branch gated on NODETERM_HOOK_SOCK', () => {
    expect(s).toContain('NODETERM_HOOK_SOCK')
    expect(s).toContain('--unix-socket')
    expect(s).toContain('/hook/claude')
  })
  it('still no-ops without node id / endpoint', () => {
    expect(s).toContain('NODETERM_NODE_ID')
  })

  describe('deterministic hook-reply approvals (PermissionRequest wait branch)', () => {
    it('gates the wait branch on NODETERM_PERM_WAIT_SECS > 0', () => {
      expect(s).toContain('[ -n "$NODETERM_PERM_WAIT_SECS" ] && [ "$NODETERM_PERM_WAIT_SECS" -gt 0 ]')
    })
    it('only arms on a PermissionRequest hook', () => {
      expect(s).toContain('"hook_event_name":"PermissionRequest"')
    })
    it('generates a pendingId and writes the request file under ~/.nodeterm/pending with umask 077', () => {
      expect(s).toContain('nt_pending="${nt_node}-${nt_ms}-$$"')
      expect(s).toContain('$HOME/.nodeterm/pending')
      expect(s).toContain('(umask 077; mkdir -p "$nt_dir")')
      expect(s).toContain('(umask 077; printf %s "$payload" > "$nt_pending_file")')
    })
    it('sanitizes the node id to the safe filename charset', () => {
      expect(s).toContain("tr -c 'A-Za-z0-9_-' '_'")
    })
    it('tags the POST body with nodeterm_pending_id on both transports', () => {
      // Four POST blocks now carry the tag: the initial request POST (unix-socket + TCP) AND the
      // "answered" signal POST fired from the wait branch (unix-socket + TCP).
      const matches = s.match(/--data-urlencode "nodeterm_pending_id=\$\{nt_pending\}"/g) ?? []
      expect(matches.length).toBe(4)
    })
    it('fires a backgrounded "answered" POST in the wait branch after reading a valid answer', () => {
      // Guarded on a valid allow/deny answer, tagged nodeterm_answered on both transports, and
      // backgrounded (& + short --max-time) so the decision JSON is never delayed.
      expect(s).toContain('if [ "$nt_decision" = "allow" ] || [ "$nt_decision" = "deny" ]; then')
      const answered = s.match(/--data-urlencode "nodeterm_answered=\$\{nt_decision\}"/g) ?? []
      expect(answered.length).toBe(2)
      const backgrounded = s.match(/--data-urlencode "payload=\$\{payload\}" >\/dev\/null 2>&1 &/g) ?? []
      expect(backgrounded.length).toBe(2)
      expect(s).toContain('--max-time 1')
    })
    it('does NOT fire the answered POST on timeout (only inside the answer-found branch)', () => {
      // The answered POST lives strictly between reading the answer file and the timeout cleanup:
      // it appears before the "Timed out" comment, and the timeout tail has no answered field.
      const answeredIdx = s.indexOf('nodeterm_answered')
      const timeoutIdx = s.indexOf('# Timed out')
      expect(answeredIdx).toBeGreaterThan(-1)
      expect(timeoutIdx).toBeGreaterThan(answeredIdx)
      const timeoutTail = s.slice(timeoutIdx)
      expect(timeoutTail).not.toContain('nodeterm_answered')
    })
    it('polls the answer file every 0.5s up to the armed seconds', () => {
      expect(s).toContain('nt_answer="$HOME/.nodeterm/pending/$nt_pending.answer"')
      expect(s).toContain('nt_max=$((NODETERM_PERM_WAIT_SECS * 2))')
      expect(s).toContain('sleep 0.5')
    })
    it('prints the exact allow / deny decision JSON', () => {
      expect(s).toContain(
        '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}'
      )
      expect(s).toContain('"behavior":"deny"')
      expect(s).toContain('"message":"Denied from nodeterm."')
    })
    it('cleans up request + answer files and, on timeout, removes the request file', () => {
      expect(s).toContain('rm -f "$nt_answer" "$nt_pending_file"')
      expect(s).toContain('rm -f "$nt_pending_file"')
    })
    it('is a no-op branch for a non-claude agent script too (env-gated, present but inert)', () => {
      const codex = buildManagedScript('codex')
      expect(codex).toContain('NODETERM_PERM_WAIT_SECS')
      expect(codex).toContain('/hook/codex')
    })
  })

  describe('endpoint failover (dead-primary retry against a live sibling endpoint)', () => {
    it('lists the three known candidate endpoint files', () => {
      expect(s).toContain('"$HOME/.nodeterm-server/hook-endpoint.env"')
      expect(s).toContain('"$HOME/.config/node-terminal/hook-endpoint.env"')
      expect(s).toContain('"$HOME/Library/Application Support/node-terminal/hook-endpoint.env"')
    })
    it('picks the FRESHEST existing candidate (ls -t | head -n 1)', () => {
      expect(s).toContain('nt_fresh=$(ls -t "$@" 2>/dev/null | head -n 1)')
    })
    it('SKIPS the endpoint file already tried (compares each candidate to the tried path)', () => {
      expect(s).toContain('nt_pick_fallback "$NODETERM_HOOK_ENDPOINT"')
      expect(s).toContain('nt_tried="$1"')
      expect(s).toContain('[ "$nt_c" = "$nt_tried" ] && continue')
    })
    it('only considers readable candidates and returns 1 when there are none', () => {
      expect(s).toContain('[ -r "$nt_c" ] || continue')
      expect(s).toContain('[ "$#" -gt 0 ] || return 1')
    })
    it('clears SOCK/PORT before sourcing the fallback so a transport switch takes effect', () => {
      const clearSock = s.indexOf('NODETERM_HOOK_SOCK=""')
      const clearPort = s.indexOf('NODETERM_HOOK_PORT=""')
      const source = s.indexOf('. "$nt_fresh"')
      expect(clearSock).toBeGreaterThan(-1)
      expect(clearPort).toBeGreaterThan(-1)
      expect(source).toBeGreaterThan(clearSock)
      expect(source).toBeGreaterThan(clearPort)
    })
    it('re-POSTs against the fallback exactly ONCE on a failed primary POST', () => {
      // nt_send_request: primary attempt short-circuits on success (`&& return 0`), else a single
      // fallback source + one re-POST. No loop → at most one retry.
      expect(s).toContain('nt_request_post && return 0')
      expect(s).toContain('if nt_pick_fallback "$NODETERM_HOOK_ENDPOINT"; then')
      // Count CALLS (followed by whitespace/EOL), not the `nt_request_post() {` definition (`(`).
      const reposts = s.match(/\n *nt_request_post(?=\s|$)/g) ?? []
      // Two textual calls: the primary attempt and the single fallback retry.
      expect(reposts.length).toBe(2)
    })
    it('leaves the happy path untouched: a successful primary POST does no fallback work', () => {
      // `&& return 0` guarantees nt_pick_fallback / the candidate scan never run when curl exits 0.
      const send = s.slice(s.indexOf('nt_send_request() {'), s.indexOf('nt_send_request() {') + 200)
      expect(send).toContain('nt_request_post && return 0')
    })
    it('returns curl exit status from nt_request_post (no `|| true` masking) and returns 1 with no transport', () => {
      // The POST lines end at `>/dev/null 2>&1` (status preserved), NOT `>/dev/null 2>&1 || true`.
      expect(s).not.toContain('--data-urlencode "payload=${payload}" >/dev/null 2>&1 || true')
      expect(s).toContain('  else\n    return 1\n  fi')
    })
    it('perm-wait branch advertises the ask in the FOREGROUND (before the poll), non-perm backgrounds it', () => {
      // Foreground in perm-wait (pendingId reaches primary-or-fallback before the answer poll begins),
      // backgrounded otherwise so a live session's hot path never blocks.
      expect(s).toContain('if [ -n "$nt_pending" ]; then\n  nt_send_request\nelse\n  nt_send_request &\nfi')
      // The request POST carries nodeterm_pending_id, so the fallback learns the ask too.
      expect(s).toContain('--data-urlencode "nodeterm_pending_id=${nt_pending}"')
    })
  })
})

describe('buildManagedScript generated shell is syntactically valid', () => {
  const sh = spawnSync('sh', ['-c', 'exit 0'])
  const shAvailable = sh.status === 0 && !sh.error
  const dir = shAvailable ? mkdtempSync(join(tmpdir(), 'nt-managed-script-')) : ''
  afterAll(() => {
    if (dir) rmSync(dir, { recursive: true, force: true })
  })
  for (const agentId of ['claude', 'codex', 'gemini']) {
    it.skipIf(!shAvailable)(`passes \`sh -n\` for ${agentId}`, () => {
      const file = join(dir, `hook-${agentId}.sh`)
      writeFileSync(file, buildManagedScript(agentId), 'utf8')
      const res = spawnSync('sh', ['-n', file], { encoding: 'utf8' })
      expect(res.stderr || '').toBe('')
      expect(res.status).toBe(0)
    })
  }
})
