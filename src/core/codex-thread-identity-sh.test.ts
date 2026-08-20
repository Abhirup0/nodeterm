// The hook prelude, run by the real /bin/sh. It is prepended to every managed hook script, so a
// quoting slip here does not break "codex identity recovery" — it breaks every agent's hooks on
// every machine. It is also the one place where a data file's contents become environment
// variables, which is why the negative cases below matter as much as the positive one.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { codexThreadIdentityResolverSh } from './codex-thread-identity-sh'

const run = promisify(execFile)

let dir = ''
let root = ''
let script = ''

beforeAll(() => {
  // A space in the path on purpose: the real one is macOS's "Application Support".
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm codex prelude '))
  root = path.join(dir, 'codex-thread-nodes')
  fs.mkdirSync(root, { recursive: true })
  script = path.join(dir, 'prelude.sh')
  fs.writeFileSync(
    script,
    `#!/bin/sh\n${codexThreadIdentityResolverSh(root)}\n` +
      `printf '%s|%s|%s\\n' "\${NODETERM_NODE_ID-}" "\${NODETERM_HOOK_ENDPOINT-}" "\${NODETERM_CANVAS_CONTROL-}"\n`,
    { mode: 0o755 }
  )
})

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

function record(threadId: string, body: string): void {
  fs.writeFileSync(path.join(root, threadId), body)
}

/** Write a managed-scope record under `<root>/<accountId>/<threadId>`. */
function scopedRecord(accountId: string, threadId: string, body: string): void {
  fs.mkdirSync(path.join(root, accountId), { recursive: true })
  fs.writeFileSync(path.join(root, accountId, threadId), body)
}

/** A well-formed record body for a scope (empty account = system, no accountId line = legacy). */
function body(nodeId: string, accountId?: string): string {
  const acct = accountId === undefined ? '' : `accountId=${accountId}\n`
  return `${acct}nodeId=${nodeId}\nendpoint=${dir}/hook-endpoint.env\nsignature=x\n`
}

async function resolve(env: Record<string, string>): Promise<string> {
  const { stdout } = await run('/bin/sh', [script], {
    env: { PATH: process.env.PATH ?? '', HOME: dir, ...env }
  })
  return stdout.trim()
}

describe('codex thread identity prelude', () => {
  it('is valid POSIX sh', async () => {
    await expect(run('/bin/sh', ['-n', script])).resolves.toBeTruthy()
  })

  it('recovers the node binding a tool shell never inherited', async () => {
    record('thread-1', `nodeId=node-7\nendpoint=${dir}/hook-endpoint.env\nsignature=x\n`)
    expect(await resolve({ CODEX_THREAD_ID: 'thread-1' })).toBe(
      `node-7|${dir}/hook-endpoint.env|1`
    )
  })

  it('changes nothing when the session already knows its node', async () => {
    record('thread-1', `nodeId=node-7\nendpoint=${dir}/hook-endpoint.env\nsignature=x\n`)
    expect(await resolve({ CODEX_THREAD_ID: 'thread-1', NODETERM_NODE_ID: 'node-own' })).toBe(
      'node-own||'
    )
  })

  // #350, at the resolver: two projects, a codex node in each with its OWN thread. A daemon-spawned
  // tool shell for Project B's thread — with the daemon env CLEAN (no leaked NODETERM_NODE_ID, which
  // is what the launcher fix guarantees) — must recover B's node and NEVER A's. This is the
  // cross-project isolation the confused-deputy broke: when the daemon leaked node-A's id the guard
  // above no-opped and B's tool shell stayed node-A, so B listed A's links and routed to A.
  it('cross-project isolation: a clean tool shell for project B resolves B, never A (#350)', async () => {
    record('thread-A', `nodeId=node-A\nendpoint=${dir}/hook-endpoint.env\nsignature=x\n`)
    record('thread-B', `nodeId=node-B\nendpoint=${dir}/hook-endpoint.env\nsignature=x\n`)
    const resolvedB = await resolve({ CODEX_THREAD_ID: 'thread-B' })
    expect(resolvedB).toBe(`node-B|${dir}/hook-endpoint.env|1`)
    expect(resolvedB).not.toContain('node-A')
    // And symmetrically, A's thread never resolves to B.
    expect(await resolve({ CODEX_THREAD_ID: 'thread-A' })).toBe(
      `node-A|${dir}/hook-endpoint.env|1`
    )
  })

  it('is inert for every other agent (no CODEX_THREAD_ID, no record)', async () => {
    expect(await resolve({})).toBe('||')
    expect(await resolve({ CODEX_THREAD_ID: 'unknown-thread' })).toBe('||')
  })

  it('refuses a thread id that could escape the record directory', async () => {
    expect(await resolve({ CODEX_THREAD_ID: '../../etc/passwd' })).toBe('||')
  })

  it('exports nothing when a record carries a node id or endpoint it should not', async () => {
    record('thread-bad-node', `nodeId=node 7; rm -rf /\nendpoint=${dir}/e\n`)
    expect(await resolve({ CODEX_THREAD_ID: 'thread-bad-node' })).toBe('||')
    record('thread-bad-ep', 'nodeId=node-7\nendpoint=relative/e\n')
    expect(await resolve({ CODEX_THREAD_ID: 'thread-bad-ep' })).toBe('||')
    record('thread-bad-ep2', 'nodeId=node-7\nendpoint=/etc/$(id)\n')
    expect(await resolve({ CODEX_THREAD_ID: 'thread-bad-ep2' })).toBe('||')
  })
})

// ── S6 PR 2: the account-scoped sh resolver, proven under real /bin/sh (Property 8, Constraint 8) ──
describe('codex thread identity prelude — account scoping', () => {
  // The subdir layout differs per test; clear the record store before each so scopes never bleed.
  beforeEach(() => {
    fs.rmSync(root, { recursive: true, force: true })
    fs.mkdirSync(root, { recursive: true })
  })

  it('binds the one matching managed scope when the daemon carries that account id', async () => {
    scopedRecord('acct-A', 'thr-1', body('node-A', 'acct-A'))
    expect(
      await resolve({ CODEX_THREAD_ID: 'thr-1', NODETERM_CODEX_ACCOUNT_ID: 'acct-A' })
    ).toBe(`node-A|${dir}/hook-endpoint.env|1`)
  })

  it('binds the single candidate across scopes when no account id is present (system record)', async () => {
    record('thr-1', body('node-sys')) // bare-root legacy/system record, no account line
    expect(await resolve({ CODEX_THREAD_ID: 'thr-1' })).toBe(`node-sys|${dir}/hook-endpoint.env|1`)
  })

  it('binds the single candidate across scopes when no account id is present (one managed record)', async () => {
    scopedRecord('acct-A', 'thr-1', body('node-A', 'acct-A'))
    expect(await resolve({ CODEX_THREAD_ID: 'thr-1' })).toBe(`node-A|${dir}/hook-endpoint.env|1`)
  })

  it('fails closed: two scopes hold the same thread id and no account env clears the map', async () => {
    scopedRecord('acct-A', 'thr-1', body('node-A', 'acct-A'))
    scopedRecord('acct-B', 'thr-1', body('node-B', 'acct-B'))
    // MUTATION TARGET: bind on the first match (drop `-eq 1`) ⇒ this exports node-A and reddens.
    expect(await resolve({ CODEX_THREAD_ID: 'thr-1' })).toBe('||')
  })

  it('fails closed: a system record and a managed record collide with no account env', async () => {
    record('thr-1', body('node-sys'))
    scopedRecord('acct-A', 'thr-1', body('node-A', 'acct-A'))
    expect(await resolve({ CODEX_THREAD_ID: 'thr-1' })).toBe('||')
  })

  it('clears the map when the record account line disagrees with its directory scope', async () => {
    // A record physically under acct-B but whose own line still claims acct-A: not honoured as B.
    scopedRecord('acct-B', 'thr-1', body('node-A', 'acct-A'))
    expect(
      await resolve({ CODEX_THREAD_ID: 'thr-1', NODETERM_CODEX_ACCOUNT_ID: 'acct-B' })
    ).toBe('||')
    // And the unscoped scan skips it too (the scope check fails), so nothing binds.
    expect(await resolve({ CODEX_THREAD_ID: 'thr-1' })).toBe('||')
  })

  it('reads only the named account, not a same-thread record in another scope', async () => {
    scopedRecord('acct-A', 'thr-1', body('node-A', 'acct-A'))
    scopedRecord('acct-B', 'thr-1', body('node-B', 'acct-B'))
    // With the account id pinned, the scan never touches the other account — no ambiguity, binds B.
    expect(
      await resolve({ CODEX_THREAD_ID: 'thr-1', NODETERM_CODEX_ACCOUNT_ID: 'acct-B' })
    ).toBe(`node-B|${dir}/hook-endpoint.env|1`)
  })

  it('resolves nothing for a daemon account id that could escape the mapping directory', async () => {
    scopedRecord('acct-A', 'thr-1', body('node-A', 'acct-A'))
    expect(
      await resolve({ CODEX_THREAD_ID: 'thr-1', NODETERM_CODEX_ACCOUNT_ID: '../acct-A' })
    ).toBe('||')
    expect(
      await resolve({ CODEX_THREAD_ID: 'thr-1', NODETERM_CODEX_ACCOUNT_ID: 'system' })
    ).toBe('||')
  })
})
