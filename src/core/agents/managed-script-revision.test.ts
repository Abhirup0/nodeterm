// Finding F2: an old managed script and a current one whose token file is merely missing were
// BYTE-IDENTICAL on the wire. The POST's `version` field is sourced from the ENDPOINT FILE
// (hook-server writes NODETERM_HOOK_VERSION into it), so it reports the SERVER's protocol version
// and says nothing about the client; and neither case sends a node-token header. The two need
// OPPOSITE advice — "reconnect the project / restart the app" vs "retry after its next turn" — so
// until the client stamped itself, one of those answers was permanently wrong.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildManagedScript,
  MANAGED_SCRIPT_REVISION,
  MIN_TOKEN_AWARE_REVISION
} from './hooks/managed-script'
import { hookServer } from './hook-server'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { reduceEntry } from '../agent-status-mirror'
import type { NormalizedAgentEvent } from '../../shared/agents/normalize'

describe('the managed script stamps its own revision', () => {
  it('emits the client header, on STDIN via the shared config emitter — never argv', () => {
    const s = buildManagedScript('claude', null)
    expect(s).toContain(`X-Nodeterm-Hook-Client: %s`)
    expect(s).toContain(`nt_client_rev=${MANAGED_SCRIPT_REVISION}`)
    // Global Constraint 6: no new -H anywhere. A revision is not a credential, but the rule is
    // "every hook header goes through the one emitter", and an argv exception is how the next one
    // gets added beside it.
    expect(s).not.toMatch(/-H\s+["']X-Nodeterm/)
  })

  it('the revision is comparable, and the token-aware floor is at or below it', () => {
    expect(Number.isInteger(MANAGED_SCRIPT_REVISION)).toBe(true)
    expect(MIN_TOKEN_AWARE_REVISION).toBeLessThanOrEqual(MANAGED_SCRIPT_REVISION)
  })

  it('the script survives the failover with its stamp intact', () => {
    // nt_pick_fallback clears SOCK/PORT/NODE_TOKEN_DIR because those belong to the adopted
    // instance. The client revision is a property of THIS SCRIPT and must NOT be cleared.
    const s = buildManagedScript('claude', null)
    const fb = s.slice(s.indexOf('nt_pick_fallback()'), s.indexOf('nt_request_post()'))
    expect(fb).not.toContain('nt_client_rev=')
    // And it is assigned before the emitter that reads it is ever called.
    expect(s.indexOf('nt_client_rev=')).toBeLessThan(s.indexOf('nt_hook_headers() {'))
  })
})

describe('the hook server can now tell a stale script from a missing token', () => {
  const SECRET = Buffer.alloc(32, 7)
  let dir = ''
  let events: NormalizedAgentEvent[] = []

  function post(headers: Record<string, string>): Promise<Response> {
    const payload = JSON.stringify({ hook_event_name: 'Stop', session_id: 's1' })
    return fetch(`http://127.0.0.1:${hookServer.getPort()}/hook/claude`, {
      method: 'POST',
      headers: {
        'X-Nodeterm-Hook-Token': hookServer.getToken(),
        'content-type': 'application/x-www-form-urlencoded',
        ...headers
      },
      body: `nodeId=n1&payload=${encodeURIComponent(payload)}`
    })
  }

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'hook-client-rev-'))
    resetPlatformForTests()
    initPlatform(fakePlatform({ userDataDir: dir }))
    await hookServer.start()
    hookServer.setNodeAuthSecret(SECRET)
    hookServer.setListener((e) => events.push(e))
  })

  afterAll(() => {
    hookServer.clearNodeAuthSecretForTests()
    hookServer.setListener(() => {})
    hookServer.stop()
    rmSync(dir, { recursive: true, force: true })
  })

  beforeEach(() => {
    events = []
  })

  it('records the client revision on the mirror entry', async () => {
    const res = await post({ 'X-Nodeterm-Hook-Client': String(MANAGED_SCRIPT_REVISION) })
    expect(res.status).toBe(204)
    expect(events).toHaveLength(1)
    expect(events[0].clientRevision).toBe(MANAGED_SCRIPT_REVISION)
    expect(reduceEntry(undefined, events[0], 1000).clientRevision).toBe(MANAGED_SCRIPT_REVISION)
  })

  it('leaves it UNDEFINED — never 0 — when the header is absent', async () => {
    // A pre-#195 script sends nothing. `undefined` and `0` would be read the same way by the gate
    // (both below MIN_TOKEN_AWARE_REVISION), but the trace must not claim we saw a revision zero.
    expect((await post({})).status).toBe(204)
    expect(events[0].clientRevision).toBeUndefined()
    expect(reduceEntry(undefined, events[0], 1000).clientRevision).toBeUndefined()
  })

  it('leaves it undefined for a header that is not an integer', async () => {
    expect((await post({ 'X-Nodeterm-Hook-Client': 'v3-beta' })).status).toBe(204)
    expect(events[0].clientRevision).toBeUndefined()
  })

  it('never lets the stamp itself become a gate — a stale client still posts, 204, listeners fired', async () => {
    // The fail-open contract is the whole route's contract, and it is not weakened by making the
    // client visible: an ANCIENT revision is data for the refusal message, never a refusal here.
    expect((await post({ 'X-Nodeterm-Hook-Client': '1' })).status).toBe(204)
    expect(events).toHaveLength(1)
    expect(events[0].clientRevision).toBe(1)
    expect(events[0].nodeId).toBe('n1')
  })

  it('the mirror keeps the stamp on the same edge it keeps the proof, and forgets neither', () => {
    const ev = (o: Partial<NormalizedAgentEvent>): NormalizedAgentEvent =>
      ({ kind: 'state', agentId: 'claude', nodeId: 'n1', ...o }) as NormalizedAgentEvent
    const a = reduceEntry(undefined, ev({ state: 'done', verified: true, clientRevision: 3 }), 1000)
    expect(a.clientRevision).toBe(3)
    // A later event from a DOWNGRADED client (the SSH project reconnected against an older
    // desktop) must move the recorded revision down, not keep the flattering one.
    const b = reduceEntry(a, ev({ state: 'working', newTurn: true, clientRevision: 1 }), 2000)
    expect(b.clientRevision).toBe(1)
    // And an event with no stamp at all clears it: that IS the pre-#195 client, reporting.
    const c = reduceEntry(b, ev({ state: 'done' }), 3000)
    expect(c.clientRevision).toBeUndefined()
  })
})
