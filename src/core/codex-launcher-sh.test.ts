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
let startDelayMs = 0
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
    if (startDelayMs) await new Promise((r) => setTimeout(r, startDelayMs))
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
  startDelayMs = 0
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

  // Two facts wore one reason before, and the string named only the first ("an older CLI"), which
  // sent a reader of a codex 0.146.0 node hunting for a version problem it did not have.
  it('an older codex with no app-server → plain codex, not a dead node', async () => {
    const runtime = path.join(dir, '.codex', 'packages', 'standalone', 'current')
    fs.mkdirSync(runtime, { recursive: true })
    fs.writeFileSync(path.join(runtime, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    try {
      const noServer = path.join(dir, 'nodeterm-codex-no-server')
      fs.writeFileSync(noServer, buildCodexLauncherScript('false'), { mode: 0o755 })
      await callLauncher(['hello'], {}, noServer)
      expect(codexArgv()).toEqual(['hello'])
      expect(fallbacks).toEqual([{ nodeId: 'node-1', reason: 'app-server-unavailable' }])
    } finally {
      fs.rmSync(path.join(dir, '.codex'), { recursive: true, force: true })
    }
  })

  it('an npm/snap codex with no standalone runtime → its own reason, not "an older CLI"', async () => {
    // MEASURED: codex-cli 0.146.0 installed via npm answers `app-server daemon start` with
    // "managed standalone Codex install not found at ~/.codex/packages/standalone/current/codex".
    // The caps probe normally keeps this case away from the launcher entirely — but the pane
    // resolves CODEX_HOME from its OWN environment (§8.5) and an install can be removed after boot.
    const noServer = path.join(dir, 'nodeterm-codex-no-standalone')
    fs.writeFileSync(noServer, buildCodexLauncherScript('false'), { mode: 0o755 })
    await callLauncher(['hello'], {}, noServer)
    expect(codexArgv()).toEqual(['hello'])
    expect(fallbacks).toEqual([{ nodeId: 'node-1', reason: 'codex-standalone-missing' }])
  })

  it('honors CODEX_HOME when deciding which of the two it hit', async () => {
    const home = path.join(dir, 'relocated-codex')
    const runtime = path.join(home, 'packages', 'standalone', 'current')
    fs.mkdirSync(runtime, { recursive: true })
    fs.writeFileSync(path.join(runtime, 'codex'), '#!/bin/sh\nexit 0\n', { mode: 0o755 })
    const noServer = path.join(dir, 'nodeterm-codex-relocated')
    fs.writeFileSync(noServer, buildCodexLauncherScript('false'), { mode: 0o755 })
    await callLauncher(['hello'], { CODEX_HOME: home }, noServer)
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

describe('a start handler that takes real time', () => {
  // REGRESSION. `/codex-thread/start` mints a thread through a five-step conversation with an
  // app-server that is typically COLD — the first codex node after boot. The route inherited the
  // 2s slowloris guard (a RECEIVE-phase guard), so the socket was destroyed while the handler was
  // still working: curl failed, the launcher fell back to plain codex, and the server went on to
  // create the thread and write a record for it. An orphan thread and an orphan record, per
  // attempt, in the most common case there is. A handler that resolves synchronously — which is
  // what this suite used to have — cannot see any of that.
  it('is waited for, and its thread is the one codex resumes', async () => {
    startDelayMs = 3000
    await callLauncher([])
    expect(codexArgv()).toEqual(['--remote unix:// resume thread-abc'])
    expect(fallbacks).toEqual([])
  }, 20_000)
})

describe('per-node capability (the authorization the shared bearer cannot give)', () => {
  it('the fallback report is trusted only when it presents no token at all', async () => {
    // The one route the capability is not required on — because the commonest thing it reports is
    // that there was no capability to present. The exemption is exactly that narrow: a report that
    // DOES carry a token must carry the right one, or a session holding only the shared bearer
    // could flag a sibling node as fallen back.
    const post = (nodeId: string, headers: Record<string, string>) =>
      fetch(`http://127.0.0.1:${hookServer.getPort()}/codex-thread/fallback`, {
        method: 'POST',
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          'x-nodeterm-hook-token': hookServer.getToken(),
          ...headers
        },
        body: `nodeId=${nodeId}&reason=broker-unreachable`
      })
    expect((await post('node-1', {})).status).toBe(204)
    expect(fallbacks).toEqual([{ nodeId: 'node-1', reason: 'broker-unreachable' }])
    const wrong = await post('node-1', {
      'x-nodeterm-node-token': hookServer.codexNodeAuthToken('node-2')
    })
    expect(wrong.status).toBe(403)
    expect(fallbacks).toHaveLength(1)
    const right = await post('node-1', {
      'x-nodeterm-node-token': hookServer.codexNodeAuthToken('node-1')
    })
    expect(right.status).toBe(204)
    expect(fallbacks).toHaveLength(2)
  })

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
