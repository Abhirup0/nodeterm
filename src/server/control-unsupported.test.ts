/**
 * The Server Edition's `/control/*` answer, proven on the wire.
 *
 * The defect being fixed is a WORDING one with a behavioural cost: `control unavailable` + HTTP 400
 * is indistinguishable from a transient outage, and a language model retries an outage. So the
 * assertions here are about what the caller can conclude — a stable machine name, and prose that
 * contains the literal "do not retry" — not merely about a status code.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform } from '../core/platform-fake'
import { hookServer, MESSAGING_CONTROL_REFUSAL } from '../core/agents/hook-server'
import { nodeAuthToken } from '../core/agents/node-auth-token'
import { STRICT_CONTROL_REFUSAL } from '../core/agents/node-identity-policy'
import {
  BROWSER_UNSUPPORTED_CLAUSE,
  CONTROL_UNSUPPORTED_ERROR,
  CONTROL_UNSUPPORTED_SENTENCE,
  controlUnsupportedMessage,
  serverEditionControlHandler
} from './control-unsupported'

const SECRET = Buffer.alloc(32, 7)
let dir = ''

function control(verb: string, nodeId: string, accept = 'text/plain', token?: string) {
  const headers: Record<string, string> = {
    'X-Nodeterm-Hook-Token': hookServer.getToken(),
    'content-type': 'application/x-www-form-urlencoded',
    accept
  }
  if (token) headers['X-Nodeterm-Node-Token'] = token
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/control/${verb}`, {
    method: 'POST',
    headers,
    body: `nodeId=${encodeURIComponent(nodeId)}`
  })
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-ctl-unsupported-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  hookServer.setNodeAuthSecret(SECRET)
  // The exact registration `src/server/index.ts` performs after `hookServer.start()`.
  hookServer.setControlHandler(serverEditionControlHandler)
})

afterAll(() => {
  hookServer.clearNodeAuthSecretForTests()
  hookServer.stop()
  resetPlatformForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('the Server Edition refuses canvas control by name', () => {
  it('answers every verb with the same machine-readable error, in JSON', async () => {
    for (const verb of ['list', 'open-terminal', 'write']) {
      const res = await control(verb, 'n-1', 'application/json')
      expect(res.status, verb).toBe(400)
      const body = (await res.json()) as { ok: boolean; error: string; message: string }
      expect(body.ok, verb).toBe(false)
      // The name is EXACT and stable — this is the field a client is allowed to branch on.
      expect(body.error, verb).toBe(CONTROL_UNSUPPORTED_ERROR)
      expect(body.error, verb).not.toBe('control unavailable')
    }
  })

  it('tells a text/plain caller, in words, not to retry', async () => {
    // Verified, so the reply is the refusal alone: an unverified caller inside the warning window
    // gets the identity note prefixed on top, which is existing behaviour and not what is measured
    // here.
    const res = await control('open-terminal', 'n-2', 'text/plain', nodeAuthToken(SECRET, 'n-2'))
    expect(res.status).toBe(400)
    const text = await res.text()
    // The literal the whole change exists for.
    expect(text).toContain('do not retry')
    expect(text).toContain('permanent')
    // …and the name, because the text dialect carries no fields.
    expect(text).toContain(CONTROL_UNSUPPORTED_ERROR)
    expect(text).toContain(CONTROL_UNSUPPORTED_SENTENCE)
    // One line: the shim prints the body as-is.
    expect(text.trimEnd()).not.toContain('\n')
  })

  it('the messaging verbs get the same NAMED refusal — /control/send is 400, never an outage', async () => {
    // Task 5.3 of the messaging plan, shared with this mechanism by agreement. `send` is
    // verified-only at the route (requiresVerified runs before the handler on every edition), so
    // a token is presented here for the same reason the `browser` test presents one: the edition
    // answer is what a caller that got PAST identity hears.
    const res = await control('send', 'n-msg', 'text/plain', nodeAuthToken(SECRET, 'n-msg'))
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain(CONTROL_UNSUPPORTED_ERROR)
    expect(text).toContain('do not retry')
  })

  it('`open-project` is unreachable on this edition — the P8 pin for issue #338', async () => {
    // No server code changed for #338 and none may need to: the SE registers this handler for
    // ALL verbs, so open-project (and any --project-carrying open) answers the same permanent
    // named refusal. Pinned by name so the contract cannot drift silently.
    expect(await serverEditionControlHandler({ verb: 'open-project' })).toEqual({
      ok: false,
      error: CONTROL_UNSUPPORTED_ERROR,
      message: controlUnsupportedMessage('open-project')
    })
    // And on the wire: open-project is verified-only at the route (requiresVerified runs before
    // the handler on every edition), so a token is presented — the edition answer is what a
    // caller that got PAST identity hears.
    const res = await control('open-project', 'n-op', 'text/plain', nodeAuthToken(SECRET, 'n-op'))
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain(CONTROL_UNSUPPORTED_ERROR)
    expect(text).toContain('do not retry')
  })

  it('an unverified `send` is refused on IDENTITY first, and that refusal does not invite a retry either', async () => {
    const res = await control('send', 'n-msg2')
    expect(res.status).toBe(403)
    expect((await res.text()).trim()).toBe(MESSAGING_CONTROL_REFUSAL)
  })

  it('names WHY browser control is structural, not merely unimplemented', async () => {
    // `browser` is a strict verb, so it takes a verified identity even to be told no. That
    // ordering is correct — identity runs before the handler — and it is why this test presents a
    // token where the others do not.
    const res = await control('browser', 'n-3', 'text/plain', nodeAuthToken(SECRET, 'n-3'))
    expect(res.status).toBe(400)
    const text = await res.text()
    expect(text).toContain(CONTROL_UNSUPPORTED_ERROR)
    expect(text).toContain(BROWSER_UNSUPPORTED_CLAUSE)
    expect(text).toContain('renders in your own browser')
  })

  it('adds that clause to `browser` and to nothing else', () => {
    expect(controlUnsupportedMessage('browser')).toContain(BROWSER_UNSUPPORTED_CLAUSE)
    for (const verb of ['list', 'open-terminal', 'browsers', 'BROWSER']) {
      expect(controlUnsupportedMessage(verb), verb).not.toContain(BROWSER_UNSUPPORTED_CLAUSE)
      expect(controlUnsupportedMessage(verb), verb).toContain(CONTROL_UNSUPPORTED_ERROR)
    }
  })

  it('still refuses an unverified `browser` on IDENTITY, before the edition ever answers', async () => {
    // Order matters: the identity gate runs before the handler on both shells, so a tokenless
    // caller learns nothing about the edition. Neither answer is a retryable outage.
    const res = await control('browser', 'n-4')
    expect(res.status).toBe(403)
    expect((await res.text()).trim()).toBe(STRICT_CONTROL_REFUSAL)
  })

  it('never resolves ok — there is nothing on this host for a verb to act on', async () => {
    expect(await serverEditionControlHandler({ verb: 'list' })).toEqual({
      ok: false,
      error: CONTROL_UNSUPPORTED_ERROR,
      message: controlUnsupportedMessage('list')
    })
  })
})

describe('the Server Edition wires it at boot', () => {
  it('registers the refusing handler instead of leaving the null branch', () => {
    // A hook-server change made on one shell only has shipped wrong three times in this repo, and
    // the null branch is invisible until an agent hits it in production.
    const src = fs.readFileSync(path.resolve(__dirname, 'index.ts'), 'utf8')
    expect(src).toContain('setControlHandler(serverEditionControlHandler)')
  })
})

/**
 * The reply shape this refusal needed: a FAILURE may now carry a machine name in `error` and a
 * sentence in `message`, and the text dialect prefers the sentence. Every pre-existing handler
 * sends `error` alone, so the fallback is what they all still take — pinned here because a silent
 * change of dialect for every failing verb would be a much bigger deal than this feature.
 */
describe('a failing verb that carries only `error` is rendered exactly as before', () => {
  it('falls back to the error string in text, and keeps the JSON field', async () => {
    hookServer.setControlHandler(async () => ({ ok: false, error: 'boom' }))
    try {
      const text = await control('open-terminal', 'n-5', 'text/plain', nodeAuthToken(SECRET, 'n-5'))
      expect(text.status).toBe(400)
      expect((await text.text()).trim()).toBe('boom')
      const json = await control('open-terminal', 'n-6', 'application/json', nodeAuthToken(SECRET, 'n-6'))
      expect(await json.json()).toEqual({ ok: false, error: 'boom' })
    } finally {
      hookServer.setControlHandler(serverEditionControlHandler)
    }
  })
})
