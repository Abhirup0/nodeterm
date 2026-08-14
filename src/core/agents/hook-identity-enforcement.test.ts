// A13 — per-route identity enforcement on `/control/*` and `/context-link/*`.
//
// Real hook server, real POSTs, spies for the handlers: "refused" here means the handler never ran,
// not that the reply looked unhappy. The properties this file exists to pin:
//
//  - trust on first proof: a node that has never presented a token keeps the legacy path; one that
//    HAS is latched, and an unverified request for it afterwards is refused.
//  - a FOREIGN kid never proves a node and is never caught by the latch — that is what keeps the
//    documented cross-instance failover alive.
//  - the latch is in memory only. Persisting it would let one filesystem accident brick a node
//    forever; a restart must re-earn it, which it does within one hook event.
//  - the dated window: an unverified mutation EXECUTES and carries the restart line until
//    2026-10-13, and is refused with the same shape afterwards.
//  - `write`/`close` keep their user confirmation whatever the token says.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { hookServer } from './hook-server'
import { nodeAuthToken } from './node-auth-token'
import {
  IDENTITY_REFUSED_NOTE,
  IDENTITY_RESTART_NOTE,
  NODE_IDENTITY_STRICT_AFTER,
  TOLERANT_CONTROL_VERBS
} from './node-identity-policy'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'

const SECRET = Buffer.alloc(32, 11)
// Another instance's secret ⇒ another instance's kid ⇒ the `legacy` failover verdict, NOT `forged`.
const OTHER_SECRET = Buffer.alloc(32, 13)

const IN_WINDOW = new Date('2026-09-01T00:00:00Z')
const PAST_CUTOFF = new Date('2026-11-01T00:00:00Z')

let dir = ''
let controlCalls: { verb: string; nodeId: string }[] = []
let contextCalls: { verb: string; nodeId: string }[] = []

function headers(token?: string): Record<string, string> {
  const h: Record<string, string> = {
    'X-Nodeterm-Hook-Token': hookServer.getToken(),
    'content-type': 'application/x-www-form-urlencoded',
    accept: 'text/plain'
  }
  if (token !== undefined) h['X-Nodeterm-Node-Token'] = token
  return h
}

function control(verb: string, nodeId: string, token?: string, accept = 'text/plain'): Promise<Response> {
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/control/${verb}`, {
    method: 'POST',
    headers: { ...headers(token), accept },
    body: `nodeId=${encodeURIComponent(nodeId)}`
  })
}

function contextLink(verb: string, nodeId: string, token?: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/context-link/${verb}`, {
    method: 'POST',
    headers: headers(token),
    body: `nodeId=${encodeURIComponent(nodeId)}`
  })
}

/** A real hook event — the only thing that can put a node in `provenNodes`. */
function hookEvent(nodeId: string, token?: string): Promise<Response> {
  const payload = JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 's', prompt: 'hi' })
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/hook/claude`, {
    method: 'POST',
    headers: headers(token),
    body: `nodeId=${encodeURIComponent(nodeId)}&payload=${encodeURIComponent(payload)}`
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'hooksrv-identity-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  hookServer.setNodeAuthSecret(SECRET)
  hookServer.setControlHandler(async ({ verb, nodeId }) => {
    controlCalls.push({ verb, nodeId })
    return { ok: true, message: `did ${verb}` }
  })
  hookServer.setContextLinkHandler(async ({ verb, nodeId }) => {
    contextCalls.push({ verb, nodeId })
    return 'the linked transcript'
  })
})

afterAll(() => {
  hookServer.setIdentityClockForTests(() => new Date())
  hookServer.setIdentityStrictOverride(() => undefined)
  hookServer.clearNodeAuthSecretForTests()
  hookServer.stop()
  resetPlatformForTests()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  controlCalls = []
  contextCalls = []
  hookServer.setIdentityClockForTests(() => IN_WINDOW)
  hookServer.setIdentityStrictOverride(() => undefined)
})

describe('/control/* during the warning window', () => {
  it('runs an unverified mutation and prefixes the reply with the restart note', async () => {
    const res = await control('open-terminal', 'n-window')
    expect(res.status).toBe(200)
    const body = await res.text()
    // It EXECUTED — that is the promise of the window.
    expect(controlCalls).toEqual([{ verb: 'open-terminal', nodeId: 'n-window' }])
    expect(body.startsWith(IDENTITY_RESTART_NOTE)).toBe(true)
    // …and the reply the agent came for is still there, under the note.
    expect(body).toContain('did open-terminal')
  })

  it('never warns a verified mutation', async () => {
    const res = await control('open-terminal', 'n-verified', nodeAuthToken(SECRET, 'n-verified'))
    expect(res.status).toBe(200)
    const body = await res.text()
    expect(body).not.toContain(IDENTITY_RESTART_NOTE)
    expect(body.trim()).toBe('did open-terminal')
    expect(controlCalls).toHaveLength(1)
  })

  it('lets a tolerant verb through silently — it leaks canvas shape but changes nothing', async () => {
    const res = await control('list', 'n-list')
    expect(res.status).toBe(200)
    expect(await res.text()).not.toContain(IDENTITY_RESTART_NOTE)
    expect(controlCalls).toEqual([{ verb: 'list', nodeId: 'n-list' }])
  })

  it('403s a forged token without a word of advice — nothing legitimate produces one', async () => {
    const forged = nodeAuthToken(SECRET, 'somebody-else')
    const res = await control('open-terminal', 'n-forged', forged)
    expect(res.status).toBe(403)
    expect(controlCalls).toEqual([])
  })
})

describe('/control/* after the cutoff', () => {
  beforeEach(() => {
    hookServer.setIdentityClockForTests(() => PAST_CUTOFF)
  })

  it('refuses an unverified mutation BEFORE the handler runs, with the same sentence', async () => {
    const res = await control('open-terminal', 'n-cutoff')
    expect(res.status).toBe(403)
    expect((await res.text()).trim()).toBe(IDENTITY_REFUSED_NOTE)
    // The point of the feature: nothing happened.
    expect(controlCalls).toEqual([])
  })

  it('answers a JSON caller in JSON, not in text', async () => {
    const res = await control('open-terminal', 'n-cutoff-json', undefined, 'application/json')
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ ok: false, error: IDENTITY_REFUSED_NOTE })
    expect(controlCalls).toEqual([])
  })

  it('still lets a verified mutation through', async () => {
    const res = await control('open-terminal', 'n-strict-ok', nodeAuthToken(SECRET, 'n-strict-ok'))
    expect(res.status).toBe(200)
    expect(controlCalls).toHaveLength(1)
  })

  it('still lets an unproven node read the canvas shape', async () => {
    const res = await control('list', 'n-strict-list')
    expect(res.status).toBe(200)
    expect(controlCalls).toEqual([{ verb: 'list', nodeId: 'n-strict-list' }])
  })
})

describe('/context-link/* degrades to prose, never to silence', () => {
  it('takes the legacy path for a node that has never proven itself', async () => {
    const res = await contextLink('transcript', 'n-ctx-legacy')
    expect(res.status).toBe(200)
    expect(await res.text()).toContain('the linked transcript')
    expect(contextCalls).toEqual([{ verb: 'transcript', nodeId: 'n-ctx-legacy' }])
  })

  it('refuses a latched node with a SENTENCE and a 200 — the agent asked for a read', async () => {
    expect((await hookEvent('n-ctx-proven', nodeAuthToken(SECRET, 'n-ctx-proven'))).status).toBe(204)
    const res = await contextLink('transcript', 'n-ctx-proven')
    // Not a 403: the shim turns any non-200 into "nodeterm unreachable", which would be a lie and
    // tells the agent nothing it can act on.
    expect(res.status).toBe(200)
    expect((await res.text()).trim()).toBe(IDENTITY_REFUSED_NOTE)
    expect(contextCalls).toEqual([])
  })

  it('403s a forged token here too', async () => {
    const res = await contextLink('transcript', 'n-ctx-forged', nodeAuthToken(SECRET, 'other'))
    expect(res.status).toBe(403)
    expect(contextCalls).toEqual([])
  })
})

describe('trust on first proof', () => {
  it('is not proven before the first hook event, and is one event later', async () => {
    expect(hookServer.isNodeProven('n-latch')).toBe(false)
    // Before proof, unverified control mutations run (with the note) — the legacy path.
    expect((await control('open-terminal', 'n-latch')).status).toBe(200)
    expect(controlCalls).toHaveLength(1)

    // ONE hook event with this node's own token is the whole ceremony. That is why a restart
    // re-proves immediately and why the latch never needs to be written down.
    expect((await hookEvent('n-latch', nodeAuthToken(SECRET, 'n-latch'))).status).toBe(204)
    expect(hookServer.isNodeProven('n-latch')).toBe(true)

    // After proof, the same tokenless request is refused — the session demonstrably CAN
    // authenticate, so one that suddenly cannot is a different process or a forgery.
    const res = await control('open-terminal', 'n-latch')
    expect(res.status).toBe(403)
    expect((await res.text()).trim()).toBe(IDENTITY_REFUSED_NOTE)
    expect(controlCalls).toHaveLength(1)
  })

  it('latches `list` too — it is not a mutation, but it is still the wrong caller', async () => {
    expect((await hookEvent('n-latch-list', nodeAuthToken(SECRET, 'n-latch-list'))).status).toBe(204)
    expect((await control('list', 'n-latch-list')).status).toBe(403)
    expect(controlCalls).toEqual([])
  })

  it('is released by hookIdentityStrict = false, without downgrading the app', async () => {
    expect((await hookEvent('n-hatch', nodeAuthToken(SECRET, 'n-hatch'))).status).toBe(204)
    expect((await control('open-terminal', 'n-hatch')).status).toBe(403)
    controlCalls = []
    hookServer.setIdentityStrictOverride(() => false)
    const res = await control('open-terminal', 'n-hatch')
    expect(res.status).toBe(200)
    expect((await res.text()).startsWith(IDENTITY_RESTART_NOTE)).toBe(true)
    expect(controlCalls).toHaveLength(1)
  })

  it('is brought forward by hookIdentityStrict = true, before the cutoff', async () => {
    hookServer.setIdentityStrictOverride(() => true)
    const res = await control('open-terminal', 'n-early-strict')
    expect(res.status).toBe(403)
    expect(controlCalls).toEqual([])
  })
})

describe('a foreign kid', () => {
  const FOREIGN = () => nodeAuthToken(OTHER_SECRET, 'n-foreign')

  it('never proves a node', async () => {
    expect((await hookEvent('n-foreign', FOREIGN())).status).toBe(204)
    expect(hookServer.isNodeProven('n-foreign')).toBe(false)
  })

  it('is never caught by the latch — the cross-instance failover has to keep working', async () => {
    // Prove the node with THIS instance's token first, so the latch is armed…
    expect((await hookEvent('n-foreign2', nodeAuthToken(SECRET, 'n-foreign2'))).status).toBe(204)
    expect(hookServer.isNodeProven('n-foreign2')).toBe(true)
    // A TOKENLESS caller is now refused…
    expect((await control('open-terminal', 'n-foreign2')).status).toBe(403)
    // …but a caller holding ANOTHER instance's token is the documented failover, not an impostor,
    // so it gets the window's behaviour: it runs, and it is told to restart.
    const res = await control('open-terminal', 'n-foreign2', nodeAuthToken(OTHER_SECRET, 'n-foreign2'))
    expect(res.status).toBe(200)
    expect((await res.text()).startsWith(IDENTITY_RESTART_NOTE)).toBe(true)
    expect(controlCalls).toEqual([{ verb: 'open-terminal', nodeId: 'n-foreign2' }])
  })
})

describe('the latch is memory, not state', () => {
  it('leaves no trace of a proven node anywhere under the data dir', async () => {
    expect((await hookEvent('n-nopersist', nodeAuthToken(SECRET, 'n-nopersist'))).status).toBe(204)
    expect(hookServer.isNodeProven('n-nopersist')).toBe(true)
    const walk = (root: string): string[] =>
      readdirSync(root).flatMap((entry) => {
        const full = join(root, entry)
        return statSync(full).isDirectory() ? walk(full) : [full]
      })
    for (const file of walk(dir)) {
      // A persisted latch is a node that one filesystem accident can brick forever. Nothing on
      // disk may know which nodes have proven themselves.
      expect(readFileSync(file, 'utf8'), file).not.toContain('n-nopersist')
    }
  })
})

describe('write/close keep the human in the loop, token or no token', () => {
  it('sends a verified destructive verb to the handler that owns the confirmation', async () => {
    const res = await control('write', 'n-write-v', nodeAuthToken(SECRET, 'n-write-v'))
    expect(res.status).toBe(200)
    // Identity never short-circuits INTO the action: it can only refuse before the handler, never
    // stand in for the dialog the handler puts up.
    expect(controlCalls).toEqual([{ verb: 'write', nodeId: 'n-write-v' }])
  })

  it('sends an unverified destructive verb there too, during the window', async () => {
    const res = await control('close', 'n-close-l')
    expect(res.status).toBe(200)
    expect(controlCalls).toEqual([{ verb: 'close', nodeId: 'n-close-l' }])
    expect((await res.text()).startsWith(IDENTITY_RESTART_NOTE)).toBe(true)
  })

  it('never waves them through as tolerant', () => {
    // The confirm-gated pair (src/main/canvas-control-core.ts `isDestructiveVerb`) is untouched by
    // this feature. Tolerance would be the one way identity could weaken it, so it is pinned here;
    // the set itself is covered in canvas-control-core.test.ts.
    expect(TOLERANT_CONTROL_VERBS.has('write')).toBe(false)
    expect(TOLERANT_CONTROL_VERBS.has('close')).toBe(false)
  })
})

describe('an instance with no secret at all', () => {
  it('gates nobody — not even past the cutoff', async () => {
    // safeStorage unavailable on the desktop, an uncreatable key file on the Server Edition. This
    // instance cannot mint a token, so nothing can ever be verified here; warning or refusing
    // `legacy` would hit EVERY caller on the machine with advice that cannot work.
    hookServer.clearNodeAuthSecretForTests()
    hookServer.setIdentityClockForTests(() => PAST_CUTOFF)
    try {
      const res = await control('open-terminal', 'n-nosecret')
      expect(res.status).toBe(200)
      const body = await res.text()
      expect(body).not.toContain(IDENTITY_RESTART_NOTE)
      expect(body.trim()).toBe('did open-terminal')
      expect(controlCalls).toHaveLength(1)
    } finally {
      hookServer.setNodeAuthSecret(SECRET)
    }
  })
})

describe('both shells wire the escape hatch', () => {
  it('is set from settings.hookIdentityStrict in the desktop AND the Server Edition', () => {
    // This repo has shipped a hook-server change to one shell only three times. An unwired shell
    // has no hatch at all, which is the one thing a stranded user cannot work around.
    const root = resolve(__dirname, '../../..')
    for (const rel of ['src/main/index.ts', 'src/server/index.ts']) {
      const src = readFileSync(join(root, rel), 'utf8')
      expect(src, rel).toContain('setIdentityStrictOverride')
      expect(src, rel).toContain('hookIdentityStrict')
    }
  })
})

describe('the injected clock', () => {
  it('is what the cutoff is read against, so a suite crosses it without touching the machine', async () => {
    hookServer.setIdentityClockForTests(() => new Date(NODE_IDENTITY_STRICT_AFTER.getTime() - 1))
    expect((await control('open-terminal', 'n-edge')).status).toBe(200)
    hookServer.setIdentityClockForTests(() => new Date(NODE_IDENTITY_STRICT_AFTER.getTime()))
    expect((await control('open-terminal', 'n-edge2')).status).toBe(403)
  })
})
