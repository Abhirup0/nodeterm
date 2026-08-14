// `/codex-thread/bind` takes a caller-supplied thread id and that id becomes a PATH SEGMENT under
// the record store (and a field inside the record signature). The route used to gate it with its
// own inline `/^[A-Za-z0-9._-]+$/` — a rule that accepts `.` and `..`, which is exactly the hole
// `isSafeNodeId` was written to close for node ids.
//
// The route now shares ONE predicate with the store (`isSafeThreadId`), so an id the store would
// refuse can never reach it through the route, and vice versa. These tests spin the real hook
// server and post real bodies; the handler is a spy, so "refused" means the handler never ran.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { hookServer } from './hook-server'
import { nodeAuthToken } from './node-auth-token'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { codexThreadIdentityRoot } from '../codex-identity-proxy'

const SECRET = Buffer.alloc(32, 3)
const NODE = 'node-thread-route'

// The exact trap rows: `.` and `..` are path segments the charset accepts, `../x` and `a/b` carry a
// separator, empty is no segment at all, and 129 chars is over the bound.
const UNSAFE_THREAD_IDS = ['.', '..', '../x', 'a/b', '', 'x'.repeat(129)]

let dir = ''
let bound: { nodeId: string; threadId: string }[] = []

function bind(threadId: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${hookServer.getPort()}/codex-thread/bind`, {
    method: 'POST',
    headers: {
      'X-Nodeterm-Hook-Token': hookServer.getToken(),
      'X-Nodeterm-Node-Token': nodeAuthToken(SECRET, NODE),
      'content-type': 'application/x-www-form-urlencoded'
    },
    body: `nodeId=${encodeURIComponent(NODE)}&threadId=${encodeURIComponent(threadId)}`
  })
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'codex-thread-route-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  await hookServer.start()
  hookServer.setNodeAuthSecret(SECRET)
  hookServer.setCodexThreadBindHandler(async ({ nodeId, threadId }) => {
    bound.push({ nodeId, threadId })
  })
})

afterAll(() => {
  hookServer.clearNodeAuthSecretForTests()
  hookServer.stop()
  resetPlatformForTests()
  rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  bound = []
})

describe('/codex-thread/bind refuses a path-unsafe thread id', () => {
  it('400s every trap row, never calls the handler, and writes no record', async () => {
    for (const threadId of UNSAFE_THREAD_IDS) {
      const res = await bind(threadId)
      expect(res.status, JSON.stringify(threadId)).toBe(400)
    }
    expect(bound).toEqual([])
    // Nothing anywhere: not in the store, and — the `..` row — not in the store's parent either.
    expect(existsSync(codexThreadIdentityRoot())).toBe(false)
    expect(readdirSync(dir)).toEqual(['hook-endpoint.env'])
  })

  it('still binds a thread id the app-server would actually mint', async () => {
    const res = await bind('0199b4b7-8d4e-7a4e-9a2f-3c9d0f1a2b3c')
    expect(res.status).toBe(204)
    expect(bound).toEqual([{ nodeId: NODE, threadId: '0199b4b7-8d4e-7a4e-9a2f-3c9d0f1a2b3c' }])
  })
})
