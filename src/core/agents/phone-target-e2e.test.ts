/**
 * The owner's requirement, as a test: a session the PHONE spawned can RECEIVE a message.
 *
 * It is written as one long test on purpose. The chain has five links and every one of them has
 * been believed-and-wrong at some point in this feature's history, so a suite of five isolated unit
 * tests would pass while the chain was broken — which is exactly how rev.3 came to state the
 * opposite of what the code does. The links, in order:
 *
 *   1. HOST STATE — the token file comes from the PERSIST sweep (`refreshNodeTokens`), the real
 *      mechanism. `ptyManager.create` is NOT involved and is deliberately not used to set this up,
 *      or the test would pass for the wrong reason and stop protecting the real path.
 *   2. PHONE-SHAPED SPAWN — exactly the two vars `HookEnv.flags` sets and nothing else (no bearer,
 *      no port, no token, no agent id, no perm-wait).
 *   3. THE HOOK POST — driven through the REAL generated managed script against a real `node:http`
 *      listener with the real `curl`, asserting the headers that actually arrived, judged by the
 *      real verifier.
 *   4. GATE 2 — the mirror records the proof from that same verdict, and the pure decider admits it.
 *   5. DELIVERY — the whole primitive against a REAL tmux pane and a real reader (Global
 *      Constraint 9), read back with `capture-pane`.
 *
 * If this test cannot pass, the answer is NEVER to weaken gate 2 (Finding F2 / Decision A1): a
 * "the host knows this node id" trust level below `verified` is true of every node on the canvas
 * including the victim, so it proves the node exists and never that the caller is it.
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { spawn, execFileSync } from 'node:child_process'
import { createServer, type IncomingMessage, type Server } from 'node:http'
import { mkdirSync, writeFileSync, mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { hookServer } from './hook-server'
import { loadOrCreateNodeAuthSecret, resetNodeAuthSecretForTests } from './node-auth-secret'
import { verifyNodeToken } from './node-auth-token'
import { buildManagedScript, MANAGED_SCRIPT_REVISION } from './hooks/managed-script'
import {
  initNodeTokens,
  refreshNodeTokens,
  sweepNodeToken
} from './node-token-service'
import { nodeTokenDir, nodeTokenFilePresent, resetNodeTokenFilesForTests } from './node-token-files'
import {
  recordAgentEvent,
  mirrorEntry,
  initAgentStatusMirror,
  _resetForTest,
  type MirrorEntry
} from '../agent-status-mirror'
import {
  decideDelivery,
  RETRYABLE,
  type DeliveryFacts
} from './agent-message-decide'
import { deliverAgentMessage, type DeliveryDeps, type DeliveryRequest } from './agent-message'
import { PANE_OWNER_FMT, foregroundArgvArgs, paneOwnerFrom, parsePaneOwner } from './pane-owner'
import { localPasteDelivery, runPasteDelivery } from '../tmux-naming'

// ── Real-tool discovery (same rules as agent-message.realtty.test.ts) ───────────────────────────
function findPasteAwareBash(): string | null {
  for (const c of ['/usr/local/bin/bash', '/opt/homebrew/bin/bash', '/bin/bash', '/usr/bin/bash']) {
    if (!existsSync(c)) continue
    try {
      const v = execFileSync(c, ['-c', 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'], {
        encoding: 'utf8'
      }).trim()
      const [maj, min] = v.split('.').map(Number)
      if (maj > 5 || (maj === 5 && min >= 1)) return c
    } catch {
      /* try the next */
    }
  }
  return null
}
function findTmux(): string | null {
  for (const c of ['/usr/local/bin/tmux', '/opt/homebrew/bin/tmux', '/usr/bin/tmux', '/bin/tmux']) {
    if (existsSync(c)) return c
  }
  return null
}
function hasCurl(): boolean {
  try {
    return execFileSync('sh', ['-c', 'command -v curl'], { encoding: 'utf8' }).trim().length > 0
  } catch {
    return false
  }
}

const BASH = findPasteAwareBash()
const TMUX = findTmux()
const CURL = hasCurl()
const NODE_ID = 'phone-1'
const SESSION = `nt-${NODE_ID}`
const NONCE = 'PHONEE2E1234'

// The host state under test. `dir` is the fake userDataDir, so `nodeTokenDir()` resolves under it
// and the persist sweep's tokens are the ones the managed script reads.
let dir = ''
let secret: Buffer
let server: Server | null = null
let port = 0
let received: { headers: Record<string, string>; body: string }[] = []
let waiters: (() => void)[] = []

// tmux
let sockDir = ''
let socket = ''
let tenv: NodeJS.ProcessEnv = {}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'phone-e2e-'))
  resetPlatformForTests()
  resetNodeAuthSecretForTests()
  resetNodeTokenFilesForTests()
  hookServer.clearNodeAuthSecretForTests()
  _resetForTest()
  initPlatform(fakePlatform({ userDataDir: dir }))
  initAgentStatusMirror(join(dir, 'agent-status.json'))

  // The hook server's secret arms per-node tokens; capture it so `verifyNodeToken` here judges with
  // the SAME secret the script's token was minted from.
  secret = await loadOrCreateNodeAuthSecret()
  hookServer.setNodeAuthSecret(secret)

  // A real listener the managed script POSTs to (curl over 127.0.0.1) — the stronger of the two
  // harnesses: it asserts what actually rode the wire, not what an emitter would build.
  server = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const headers: Record<string, string> = {}
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers[k] = v
      received.push({ headers, body: Buffer.concat(chunks).toString('utf8') })
      res.writeHead(204)
      res.end()
      for (const w of waiters.splice(0)) w()
    })
  })
  await new Promise<void>((resolve) => {
    server!.listen(0, '127.0.0.1', () => {
      const addr = server!.address()
      if (addr && typeof addr === 'object') port = addr.port
      resolve()
    })
  })

  if (TMUX) {
    sockDir = mkdtempSync(join(tmpdir(), 'phe-sk-'))
    socket = `nt-phe-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
    tenv = { ...process.env, TMUX_TMPDIR: sockDir }
  }
})

afterAll(() => {
  server?.close()
  if (TMUX && socket) {
    try {
      execFileSync(TMUX, ['-L', socket, 'kill-server'], { env: tenv, stdio: 'ignore' })
    } catch {
      /* nothing started */
    }
  }
  hookServer.clearNodeAuthSecretForTests()
  resetNodeAuthSecretForTests()
  resetNodeTokenFilesForTests()
  _resetForTest()
  resetPlatformForTests()
  for (const d of [dir, sockDir]) if (d) rmSync(d, { recursive: true, force: true })
})

// ── Harness helpers ─────────────────────────────────────────────────────────────────────────────

function nextPost(ms = 5000): Promise<{ headers: Record<string, string>; body: string }> {
  if (received.length > 0) return Promise.resolve(received[received.length - 1])
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no POST arrived')), ms)
    waiters.push(() => {
      clearTimeout(timer)
      resolve(received[received.length - 1])
    })
  })
}

/** The endpoint file the host wrote (0600), pointing at the REAL `nodeTokenDir()` the persist sweep
 *  materialised into. */
function writeEndpointFile(): string {
  const p = join(dir, 'hook-endpoint.env')
  writeFileSync(
    p,
    `NODETERM_HOOK_PORT=${port}\nNODETERM_HOOK_TOKEN=bearer-xyz\nNODETERM_HOOK_VERSION=2\n` +
      `NODETERM_NODE_TOKEN_DIR=${nodeTokenDir()}\n`,
    { encoding: 'utf8', mode: 0o600 }
  )
  return p
}

/** The phone's spawn, minus tmux: `sh <script>` with EXACTLY `HookEnv.flags`' two vars and a fresh
 *  HOME (so the failover glob finds nothing of its own). */
function runManagedScript(scriptPath: string, endpoint: string): Promise<number> {
  const home = join(dir, 'phone-home')
  mkdirSync(join(home, '.nodeterm'), { recursive: true })
  return new Promise((resolve) => {
    const child = spawn('sh', [scriptPath], {
      env: {
        HOME: home,
        PATH: process.env.PATH ?? '',
        NODETERM_HOOK_ENDPOINT: endpoint,
        NODETERM_NODE_ID: NODE_ID
      },
      stdio: ['pipe', 'ignore', 'ignore']
    })
    child.stdin.end('{"hook_event_name":"Stop","session_id":"s1"}')
    child.on('close', (code) => resolve(code ?? -1))
  })
}

const tmux = (...args: string[]): string =>
  execFileSync(TMUX as string, ['-L', socket, ...args], { env: tenv, encoding: 'utf8' })

function capturePane(session: string): string {
  try {
    return tmux('capture-pane', '-p', '-t', session)
  } catch {
    return ''
  }
}

function waitFor(cond: () => boolean, ms: number, what: string): void {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (cond()) return
    execFileSync('sleep', ['0.05'])
  }
  throw new Error(`timed out waiting for ${what}`)
}

/**
 * The fake agent is `cat` wearing claude's argv0 — NOT an interactive bash, and the difference is
 * what made this test red on GitHub runners while green locally (issue #241, failed 4/4 there).
 *
 * An `exec -a claude bash -i` has JOB CONTROL: it executes the pasted envelope line by line, and
 * every line forks a child into its OWN process group and hands it the tty's foreground. G3's
 * post-write probe reads exactly that foreground group (`pane-owner.ts`), so a probe landing in
 * one of those windows sees a different pgid/pid and reports `deliveredToReplacedTarget`. On a
 * fast machine the window is microseconds and 16/16 local runs missed it; on a loaded 2-core
 * runner the probe hit it every time. A real agent TUI never executes the payload — the envelope
 * lands in its composer — so the fork storm was a test artifact, not the production shape.
 *
 * `cat` is still a REAL reader on a real tty (the point of this e2e): it sits in the foreground
 * group reading the pane's stdin, never forks, and the tty's canonical-mode echo puts the pasted
 * frame on the pane for the capture assertions below.
 */
function startAgentPane(session: string): void {
  tmux(
    'new-session', '-d', '-s', session, '-x', '200', '-y', '40',
    `${BASH} -c 'echo READY; exec -a claude cat'`
  )
  waitFor(() => capturePane(session).includes('READY'), 5000, 'the reader')
}

function realPaneOwner(session: string): DeliveryDeps['paneOwner'] {
  return async () => {
    const identity = parsePaneOwner(tmux('display-message', '-p', '-t', session, PANE_OWNER_FMT))
    if (!identity) return null
    const call = foregroundArgvArgs(identity.tty)
    if (!call) return null
    return paneOwnerFrom(identity, execFileSync(call.bin, call.args, { encoding: 'utf8' }))
  }
}

function realSendEnvelope(session: string): DeliveryDeps['sendEnvelope'] {
  return async (_id, payload) => {
    const plan = localPasteDelivery(socket, session, payload, true)
    if (!plan) return false
    return runPasteDelivery(plan, async (args, input) => {
      execFileSync(TMUX as string, args, { env: tenv, input, encoding: 'utf8' })
    })
  }
}

/** DeliveryFacts for the pure decider — live mirror entry + live token-file presence, pane defaulted
 *  to `agent` (gate 1 is proven separately against the real kernel in link 5). */
function factsFor(nodeId: string, over: Partial<DeliveryFacts> = {}): DeliveryFacts {
  return {
    targetLive: true,
    pane: 'agent',
    target: mirrorEntry(nodeId),
    tokenFilePresent: nodeTokenFilePresent(nodeId),
    ...over
  }
}

// ── The chain ─────────────────────────────────────────────────────────────────────────────────

const full = BASH && TMUX && CURL ? it : it.skip

describe('a phone-spawned session is a valid messaging target', () => {
  full(
    'verifies, is admitted by gate 2, and receives the envelope',
    async () => {
      received = []
      waiters = []

      // 1. HOST STATE — via the PERSIST sweep, not the spawn path.
      initNodeTokens({ canvases: () => [{ id: 'p-phone', nodes: [{ id: NODE_ID }] }] })
      refreshNodeTokens({ force: true })
      expect(nodeTokenFilePresent(NODE_ID)).toBe(true)

      // 2 + 3. PHONE-SHAPED SPAWN → the real generated script → the real POST.
      const scriptPath = join(dir, 'hook.sh')
      writeFileSync(scriptPath, buildManagedScript('claude', null), { encoding: 'utf8', mode: 0o755 })
      const endpoint = writeEndpointFile()
      expect(await runManagedScript(scriptPath, endpoint)).toBe(0)
      const post = await nextPost()

      const token = post.headers['x-nodeterm-node-token']
      expect(token).toBeTruthy()
      expect(post.headers['x-nodeterm-hook-client']).toBe(String(MANAGED_SCRIPT_REVISION))
      const verdict = verifyNodeToken(secret, NODE_ID, token)
      expect(verdict).toBe('verified')

      // 4. GATE 2 — record the proof from THAT verdict (the seam hook-server drives in production is
      //    pinned by hook-identity-enforcement.test.ts; here the same real token, judged by the same
      //    verifier, drives the same reducer), then let the pure decider judge.
      recordAgentEvent({
        nodeId: NODE_ID,
        agentId: 'claude',
        kind: 'state',
        state: 'done',
        sessionId: 's1',
        verified: verdict === 'verified',
        clientRevision: Number(post.headers['x-nodeterm-hook-client'])
      })
      const entry = mirrorEntry(NODE_ID) as MirrorEntry
      expect(entry.stateVerified).toBe(true)
      expect(entry.clientRevision).toBe(MANAGED_SCRIPT_REVISION)
      expect(decideDelivery(factsFor(NODE_ID))).toEqual({ kind: 'proceed' })

      // 5. DELIVERY — the whole primitive against a REAL tmux pane and a real reader.
      startAgentPane(SESSION)
      const deps: DeliveryDeps = {
        paneOwner: realPaneOwner(SESSION),
        bracketPasteRequested: async () => true,
        sendEnvelope: realSendEnvelope(SESSION),
        mirrorEntry: (id) => mirrorEntry(id),
        tokenFilePresent: (id) => nodeTokenFilePresent(id),
        lock: async (_id, fn) => fn(),
        now: () => 1,
        nonce: () => NONCE,
        trace: async () => ({ traceId: 'e2e-1', traced: 'memory' }),
        // A bash pane emits no hook events, so the receipt is supplied here as the target's own next
        // turn WOULD arrive on the real stream — verified, exactly as `watchForReceipt` demands. This
        // is the one link a bash stub cannot produce; everything else is real.
        subscribeEvents: (cb) => {
          const t = setTimeout(() => cb({ nodeId: NODE_ID, newTurn: true, verified: true }), 20)
          return () => clearTimeout(t)
        }
      }
      const req: DeliveryRequest = {
        sourceNodeId: 'desk-1',
        targetNodeId: NODE_ID,
        sourceTitle: 'Desk',
        body: 'ping',
        targetAgentId: 'claude'
      }
      const out = await deliverAgentMessage(req, deps)
      expect(out.kind).toBe('delivered')
      waitFor(() => capturePane(SESSION).includes('END NODETERM MESSAGE'), 5000, 'the closing frame')
      const pane = capturePane(SESSION)
      expect(pane).toContain('ping')
      expect(pane).toContain('--- NODETERM MESSAGE')
    },
    45_000
  )

  // The two ways this guarantee breaks in future, each failing LOUDLY rather than silently. These
  // exercise the pure decider only, so they run on every host.
  it('breaks loudly if token materialisation is ever narrowed to the spawn path', () => {
    // Simulate: the phone-spawned node runs the CURRENT script (so not a stale-script refusal) but
    // its token was never materialised — sweep the file and do NOT re-run the persist refresh.
    recordAgentEvent({
      nodeId: NODE_ID,
      agentId: 'claude',
      kind: 'state',
      state: 'done',
      sessionId: 's1',
      verified: false,
      clientRevision: MANAGED_SCRIPT_REVISION
    })
    sweepNodeToken(NODE_ID)
    expect(nodeTokenFilePresent(NODE_ID)).toBe(false)
    expect(decideDelivery(factsFor(NODE_ID)).kind).toBe('targetStatusUnverified')
    // Named, not a silent dark node: a caller is told to fix identity, never to retry forever.
    expect(RETRYABLE['targetStatusUnverified']).toBe(false)
  })

  it('breaks loudly if the target runs a pre-identity hook script', () => {
    const stale: MirrorEntry = {
      state: 'done',
      updatedAt: 1,
      stateVerified: false,
      clientRevision: 2 // < MIN_TOKEN_AWARE_REVISION: a script that predates per-node identity
    }
    expect(decideDelivery(factsFor(NODE_ID, { target: stale })).kind).toBe('targetHookScriptStale')
    expect(RETRYABLE['targetHookScriptStale']).toBe(false)
  })
})
