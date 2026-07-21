import { describe, expect, it } from 'vitest'
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
})
