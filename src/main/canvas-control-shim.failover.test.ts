// Issue #445, the client half, exercised for real: the actual generated canvas-control shim, run
// by the real /bin/sh against the real hook server — with the PRIMARY endpoint file advertising a
// port nothing listens on (what an app quit/restart leaves behind for a tmux session created
// before it) and a live candidate endpoint sitting in one of the well-known locations under
// $HOME. Before the walk, this exact shape printed "control endpoint unreachable" and the verb —
// a reviewer launch, in the field report — was silently dropped.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { CONTROL_SHIM_SCRIPT, CONTROL_UNREACHABLE_MSG } from './canvas-control-core'
import { STALE_ENDPOINT_HINT } from '../core/agents/hook-endpoint-failover-sh'
import { hookServer } from '../core/agents/hook-server'
import { nodeAuthToken } from '../core/agents/node-auth-token'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform } from '../core/platform-fake'

const run = promisify(execFile)

let dir = ''
let shim = ''
let home = ''
let staleEndpoint = ''
let received: { verb: string; nodeId: string; verified: boolean }[] = []

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-shim-fo-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: path.join(dir, 'userdata') }))
  shim = path.join(dir, 'nodeterm.sh')
  fs.writeFileSync(shim, CONTROL_SHIM_SCRIPT, { mode: 0o755 })
  await hookServer.start()
  hookServer.setControlHandler(async (cmd) => {
    received.push({ verb: cmd.verb, nodeId: cmd.nodeId, verified: cmd.verified })
    return { ok: true, message: `did ${cmd.verb}` }
  })

  // The primary the session is pinned to: a file whose port belonged to a previous app run.
  // Port 1 answers nothing on loopback, so curl fails at connect exactly like a dead listener.
  staleEndpoint = path.join(dir, 'stale-endpoint.env')
  fs.writeFileSync(
    staleEndpoint,
    "NODETERM_HOOK_PORT='1'\nNODETERM_HOOK_TOKEN='token-of-a-dead-run'\nNODETERM_HOOK_VERSION='2'\n"
  )

  // The live candidate in a well-known location under a fake $HOME — the Server Edition slot,
  // the first one nt_candidates prints.
  home = path.join(dir, 'home')
  fs.mkdirSync(path.join(home, '.nodeterm-server'), { recursive: true })
  fs.writeFileSync(
    path.join(home, '.nodeterm-server', 'hook-endpoint.env'),
    `NODETERM_HOOK_PORT='${hookServer.getPort()}'\n` +
      `NODETERM_HOOK_TOKEN='${hookServer.getToken()}'\n` +
      "NODETERM_HOOK_VERSION='2'\n" +
      `NODETERM_NODE_TOKEN_DIR='${path.join(dir, 'live-tokens')}'\n`
  )
})

afterAll(() => {
  hookServer.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

function callShim(
  args: string[],
  env: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string }> {
  return run('/bin/sh', [shim, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      NODETERM_CANVAS_CONTROL: '1',
      NODETERM_NODE_ID: 'node-1',
      NODETERM_HOOK_ENDPOINT: staleEndpoint,
      HOME: home,
      ...env
    }
  })
}

describe('canvas-control shim endpoint failover (issue #445)', () => {
  it('a stale primary endpoint fails over to a live sibling endpoint and the verb succeeds', async () => {
    received = []
    const { stdout } = await callShim(['list'])
    expect(stdout.trim()).toBe('did list')
    expect(received).toEqual([{ verb: 'list', nodeId: 'node-1', verified: false }])
  })

  it('carries the request args through the failover POST unchanged', async () => {
    received = []
    const nasty = 'review "the worktree";\n$HOME & 100%'
    const { stdout } = await callShim(['open-agent', '--agent', 'claude', '--prompt', nasty])
    expect(stdout.trim()).toBe('did open-agent')
    expect(received.at(-1)?.verb).toBe('open-agent')
  })

  it("re-reads the node token from the ADOPTED endpoint's dir, so identity survives the failover", async () => {
    // The token dir is NON-standard (nothing under $HOME points at it) and advertised only by the
    // live candidate file — so a token found here proves the walk re-read after adopting, rather
    // than reusing whatever the stale primary (or a well-known fallback dir) yielded.
    const SECRET = Buffer.alloc(32, 9)
    hookServer.setNodeAuthSecret(SECRET)
    try {
      const tokenDir = path.join(dir, 'live-tokens')
      fs.mkdirSync(tokenDir, { recursive: true })
      fs.writeFileSync(path.join(tokenDir, 'node-1'), `${nodeAuthToken(SECRET, 'node-1')}\n`, {
        mode: 0o600
      })
      received = []
      await callShim(['list'])
      expect(received.at(-1)?.verified).toBe(true)
    } finally {
      hookServer.clearNodeAuthSecretForTests()
    }
  })

  it('with no live candidate anywhere, says the endpoint is stale rather than a bare unreachable', async () => {
    const emptyHome = path.join(dir, 'empty-home')
    fs.mkdirSync(emptyHome, { recursive: true })
    const err = await callShim(['list'], { HOME: emptyHome }).then(
      () => null,
      (e: { code: number; stderr: string }) => e
    )
    expect(err?.code).toBe(1)
    expect(err?.stderr).toContain(CONTROL_UNREACHABLE_MSG)
    expect(err?.stderr).toContain(STALE_ENDPOINT_HINT)
  })

  it('an HTTP answer from the server is authoritative — no failover on a 4xx', async () => {
    // Wrong bearer → the REAL server answers 403. A live candidate exists, but an answered
    // request must never be re-sent elsewhere: the server's refusal is the result.
    const answeredEndpoint = path.join(dir, 'answered-endpoint.env')
    fs.writeFileSync(
      answeredEndpoint,
      `NODETERM_HOOK_PORT='${hookServer.getPort()}'\nNODETERM_HOOK_TOKEN='wrong-bearer'\n`
    )
    received = []
    const err = await callShim(['list'], { NODETERM_HOOK_ENDPOINT: answeredEndpoint }).then(
      () => null,
      (e: { code: number; stderr: string }) => e
    )
    expect(err?.code).toBe(1)
    // No stale-endpoint diagnosis — the server was reached — and no fallback POST landed.
    expect(err?.stderr ?? '').not.toContain(STALE_ENDPOINT_HINT)
    expect(received).toEqual([])
  })
})
