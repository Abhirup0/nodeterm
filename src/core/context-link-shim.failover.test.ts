// Issue #445 for the context-link shim: same stale-primary / live-sibling shape as the
// canvas-control failover suite, same discipline — the real generated script under the real
// /bin/sh against the real hook server. Before the walk, a session that outlived an app restart
// read "Could not read linked context (nodeterm unreachable)." from a perfectly healthy canvas.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { CONTEXT_SHIM_SCRIPT, CONTEXT_UNREACHABLE_MSG } from './context-link-core'
import { STALE_ENDPOINT_HINT } from './agents/hook-endpoint-failover-sh'
import { hookServer } from './agents/hook-server'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'

const run = promisify(execFile)

let dir = ''
let shim = ''
let home = ''
let staleEndpoint = ''
const asked: { verb: string; nodeId: string }[] = []

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-ctx-fo-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: path.join(dir, 'userdata') }))
  shim = path.join(dir, 'context.sh')
  fs.writeFileSync(shim, CONTEXT_SHIM_SCRIPT, { mode: 0o755 })
  await hookServer.start()
  hookServer.setContextLinkHandler(async ({ verb, nodeId }) => {
    asked.push({ verb, nodeId })
    return `linked context for ${nodeId} (${verb})`
  })

  staleEndpoint = path.join(dir, 'stale-endpoint.env')
  fs.writeFileSync(
    staleEndpoint,
    "NODETERM_HOOK_PORT='1'\nNODETERM_HOOK_TOKEN='token-of-a-dead-run'\nNODETERM_HOOK_VERSION='2'\n"
  )
  home = path.join(dir, 'home')
  fs.mkdirSync(path.join(home, '.nodeterm-server'), { recursive: true })
  fs.writeFileSync(
    path.join(home, '.nodeterm-server', 'hook-endpoint.env'),
    `NODETERM_HOOK_PORT='${hookServer.getPort()}'\nNODETERM_HOOK_TOKEN='${hookServer.getToken()}'\n`
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
      NODETERM_NODE_ID: 'node-1',
      NODETERM_HOOK_ENDPOINT: staleEndpoint,
      HOME: home,
      ...env
    }
  })
}

describe('context-link shim endpoint failover (issue #445)', () => {
  it('a stale primary endpoint fails over to a live sibling endpoint and the read succeeds', async () => {
    asked.length = 0
    const { stdout } = await callShim(['summary', '--node', 'node-2'])
    expect(stdout.trim()).toBe('linked context for node-1 (summary)')
    expect(asked).toEqual([{ verb: 'summary', nodeId: 'node-1' }])
  })

  it('with no live candidate anywhere, names the stale endpoint under the generic sentence', async () => {
    const emptyHome = path.join(dir, 'empty-home')
    fs.mkdirSync(emptyHome, { recursive: true })
    const err = await callShim(['list'], { HOME: emptyHome }).then(
      () => null,
      (e: { code: number; stderr: string }) => e
    )
    expect(err?.code).toBe(1)
    expect(err?.stderr).toContain(CONTEXT_UNREACHABLE_MSG)
    expect(err?.stderr).toContain(STALE_ENDPOINT_HINT)
  })
})
