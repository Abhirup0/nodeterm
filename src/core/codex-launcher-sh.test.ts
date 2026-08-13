// The generated Codex launcher, run by the real /bin/sh against the real hook server.
//
// This script is source no compiler checks, it is the ONLY thing standing between a Codex node and
// a shell, and its most important job is the one that is hardest to assert on paper: FALLING BACK.
// Every branch below therefore runs for real, with a fake `codex` on PATH that records the argv it
// was exec'd with — because "did it fall back with the arguments intact?" is exactly the question
// a string assertion cannot answer. Same discipline as canvas-control-shim.test.ts and
// remote-claude-usage.test.ts.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { randomBytes } from 'node:crypto'
import { buildCodexLauncherScript } from './codex-identity-proxy'
import { hookServer } from './agents/hook-server'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'

const run = promisify(execFile)

let dir = ''
let launcher = ''
let binDir = ''
let argvLog = ''
let started: Array<{ nodeId: string; cwd: string }> = []
let bound: Array<{ nodeId: string; threadId: string }> = []
let fallbacks: Array<{ nodeId: string; reason?: string }> = []
let startAnswer: (() => string) | null = null
let bindAnswer: (() => void) | null = null

/** A stand-in for the real `codex`, which records how it was invoked and exits 0. */
function writeFakeCodex(): void {
  fs.writeFileSync(
    path.join(binDir, 'codex'),
    `#!/bin/sh\nprintf '%s\\n' "$*" >> ${JSON.stringify(argvLog)}\nexit 0\n`,
    { mode: 0o755 }
  )
}

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-codex-launcher-'))
  binDir = path.join(dir, 'bin')
  fs.mkdirSync(binDir)
  argvLog = path.join(dir, 'codex-argv.log')
  writeFakeCodex()
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  launcher = path.join(dir, 'nodeterm-codex')
  // `true` stands in for `codex app-server daemon start`; the "no app-server" case overrides it.
  fs.writeFileSync(launcher, buildCodexLauncherScript('true'), { mode: 0o755 })
  await hookServer.start()
  hookServer.setCodexNodeAuthSecret(randomBytes(32))
  hookServer.setCodexThreadStartHandler(async ({ nodeId, cwd }) => {
    started.push({ nodeId, cwd })
    if (!startAnswer) throw new Error('start refused')
    return startAnswer()
  })
  hookServer.setCodexThreadBindHandler(async ({ nodeId, threadId }) => {
    bound.push({ nodeId, threadId })
    if (!bindAnswer) throw new Error('bind refused')
    bindAnswer()
  })
  hookServer.setCodexIdentityListener((e) => {
    if (e.mode === 'plain') fallbacks.push({ nodeId: e.nodeId, reason: e.reason })
  })
})

afterAll(() => {
  hookServer.stop()
  resetPlatformForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => {
  started = []
  bound = []
  fallbacks = []
  startAnswer = () => 'thread-abc'
  bindAnswer = () => {}
  fs.writeFileSync(argvLog, '')
})

function baseEnv(): Record<string, string> {
  return {
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
    HOME: dir,
    NODETERM_NODE_ID: 'node-1',
    NODETERM_HOOK_ENDPOINT: hookServer.endpointFilePath(),
    // buildPtyEnv injects these at spawn too. The endpoint FILE is still required (it carries the
    // live coordinates after an app restart), but their presence is why a node whose endpoint file
    // vanished can still report that it fell back.
    NODETERM_HOOK_PORT: String(hookServer.getPort()),
    NODETERM_HOOK_TOKEN: hookServer.getToken(),
    NODETERM_CODEX_NODE_TOKEN: hookServer.codexNodeAuthToken('node-1')
  }
}

function callLauncher(
  args: string[],
  env: Record<string, string> = {},
  script = launcher
): Promise<{ stdout: string; stderr: string }> {
  const merged = { ...baseEnv(), ...env }
  for (const [k, v] of Object.entries(merged)) if (v === '') delete (merged as any)[k]
  return run('/bin/sh', [script, ...args], { env: merged, cwd: dir })
}

/** What the fake `codex` was exec'd with, one line per invocation. */
function codexArgv(): string[] {
  return fs.readFileSync(argvLog, 'utf8').split('\n').slice(0, -1)
}

describe('generated Codex launcher', () => {
  it('is valid POSIX sh', async () => {
    await expect(run('/bin/sh', ['-n', launcher])).resolves.toBeTruthy()
  })

  it('starts a thread for a fresh node and resumes it on the shared app-server', async () => {
    await callLauncher([])
    expect(started).toEqual([{ nodeId: 'node-1', cwd: fs.realpathSync(dir) }])
    expect(codexArgv()).toEqual(['--remote unix:// resume thread-abc'])
    expect(fallbacks).toEqual([])
  })

  it('keeps the caller arguments after the thread it resolved', async () => {
    await callLauncher(['--ask-for-approval', 'never', 'fix the bug'])
    expect(codexArgv()).toEqual([
      '--remote unix:// resume thread-abc --ask-for-approval never fix the bug'
    ])
  })

  it('binds a caller-supplied thread on resume instead of starting a new one', async () => {
    await callLauncher(['resume', 'thread-xyz'])
    expect(bound).toEqual([{ nodeId: 'node-1', threadId: 'thread-xyz' }])
    expect(started).toEqual([])
    expect(codexArgv()).toEqual(['--remote unix:// resume thread-xyz'])
  })
})

// Each case below is a way the managed identity can be unavailable on a real machine. The
// assertion is always the same pair: plain `codex` ran WITH THE ORIGINAL ARGUMENTS, and the
// desktop was told why. Upstream, every one of these exited 69 — a dead node.
describe('falls back to plain codex', () => {
  const cases: Array<[string, Record<string, string>, string]> = [
    ['no node id (a session nodeterm did not spawn)', { NODETERM_NODE_ID: '' }, 'node-id-unavailable'],
    [
      'no hook endpoint',
      { NODETERM_HOOK_ENDPOINT: '' },
      'hook-endpoint-unavailable'
    ],
    [
      'hook endpoint points at nothing (app restarted, tmux session outlived it)',
      { NODETERM_HOOK_ENDPOINT: '/nonexistent/hook-endpoint.env' },
      'hook-endpoint-unavailable'
    ],
    [
      'no per-node capability token (secure storage unavailable)',
      { NODETERM_CODEX_NODE_TOKEN: '' },
      'node-token-unavailable'
    ]
  ]

  for (const [name, env, reason] of cases) {
    it(`${name} → exec codex with the same args`, async () => {
      await callLauncher(['--ask-for-approval', 'never', 'do the thing'], env)
      expect(codexArgv()).toEqual(['--ask-for-approval never do the thing'])
      expect(started).toEqual([])
      // A node id is the ONLY thing the fallback report cannot be made without.
      if (env.NODETERM_NODE_ID === '') expect(fallbacks).toEqual([])
      else expect(fallbacks).toEqual([{ nodeId: 'node-1', reason }])
    })
  }

  it('an older codex with no app-server → plain codex, not a dead node', async () => {
    const noServer = path.join(dir, 'nodeterm-codex-no-server')
    fs.writeFileSync(noServer, buildCodexLauncherScript('false'), { mode: 0o755 })
    await callLauncher(['hello'], {}, noServer)
    expect(codexArgv()).toEqual(['hello'])
    expect(fallbacks).toEqual([{ nodeId: 'node-1', reason: 'app-server-unavailable' }])
  })

  it('a thread owned by another live node → plain codex, never two clients on one thread', async () => {
    bindAnswer = null
    await callLauncher(['resume', 'thread-xyz'])
    expect(codexArgv()).toEqual(['resume thread-xyz'])
    expect(fallbacks).toEqual([{ nodeId: 'node-1', reason: 'thread-bind-refused' }])
  })

  it('the app-server refusing to start a thread → plain codex', async () => {
    startAnswer = null
    await callLauncher([])
    expect(codexArgv()).toEqual([''])
    expect(fallbacks).toEqual([{ nodeId: 'node-1', reason: 'thread-start-failed' }])
  })

  it('a resume with an unusable session id → plain codex, id left alone', async () => {
    await callLauncher(['resume', 'not a; thread'])
    expect(codexArgv()).toEqual(['resume not a; thread'])
    expect(bound).toEqual([])
    expect(fallbacks).toEqual([{ nodeId: 'node-1', reason: 'thread-id-unavailable' }])
  })
})

describe('per-node capability (the authorization the shared bearer cannot give)', () => {
  it("refuses a token minted for a SIBLING node, and falls back rather than binding it", async () => {
    await callLauncher(['resume', 'thread-xyz'], {
      NODETERM_CODEX_NODE_TOKEN: hookServer.codexNodeAuthToken('node-2')
    })
    // The route rejected it before the handler ran: no binding was recorded for node-1.
    expect(bound).toEqual([])
    expect(codexArgv()).toEqual(['resume thread-xyz'])
    expect(fallbacks).toEqual([{ nodeId: 'node-1', reason: 'thread-bind-refused' }])
  })
})
