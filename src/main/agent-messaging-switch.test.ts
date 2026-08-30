/**
 * PR 6's real work: `messagingEnabled` stops being the fail-closed `() => false` placeholder and
 * becomes the per-project capability GRANT — `projectCapabilityGrantedFor(project,
 * 'agentMessaging')`, which requires BOTH the strict `=== true` flag in the git-shared
 * .nodeterm/project.json AND this machine's recorded 'kept' answer to the clone notice.
 *
 * Every test here drives the REAL control path (`deliverFromControl`) with `messagingEnabled`
 * wired exactly as production wires it (`messagingEnabledVia`); the second half additionally runs
 * a REAL WorkspaceStore over real files, so the store's `capabilityProjectFor` — the one reader
 * the desktop wiring consults — is what decides.
 *
 * THE TRAP THIS FILE EXISTS TO CATCH (PR #213 review, I2): wiring the raw file bit
 * (`projectCapabilityFlagInFile`) instead of the grant. The pending-notice and declined tests
 * below go red on exactly that swap — the flag answers `true` in both, and delivery must refuse.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import {
  deliverFromControl,
  messagingEnabledVia,
  type AgentMessagingDeps
} from './agent-messaging'
import type { CapabilityAckMap } from '../core/project-capability-consent'
import { resetMessageFlow } from '../core/agents/agent-message-flow'
import {
  recordFreshSpawnOwner,
  paneOwnerProject,
  resetPaneOwnershipForTests
} from '../core/agents/pane-ownership'
import { resetAgentMessageTraceForTests } from '../core/agents/agent-message-trace'
import { MANAGED_SCRIPT_REVISION } from '../core/agents/hooks/managed-script'
import type { MirrorEntry } from '../core/agent-status-mirror'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform } from '../core/platform-fake'
import { WorkspaceStore } from '../core/workspace-store'
import type { Project, Workspace } from '../shared/types'

const idle: MirrorEntry = {
  state: 'done',
  updatedAt: 1,
  stateVerified: true,
  clientRevision: MANAGED_SCRIPT_REVISION
}

/** The happy-path service deps from agent-messaging.test.ts, minus `messagingEnabled` and
 *  `projects` — each test supplies those two, because they are what this file is about. */
function baseDeps(
  over: Partial<AgentMessagingDeps>
): AgentMessagingDeps & { sent: { nodeId: string; payload: string }[] } {
  const sent: { nodeId: string; payload: string }[] = []
  return {
    sent,
    paneOwner: async () => ({
      tty: '/dev/pts/9',
      panePid: 100,
      paneId: '%1',
      command: 'claude',
      argv: ['claude'],
      pids: [200]
    }),
    sendEnvelope: async (nodeId, payload) => {
      sent.push({ nodeId, payload })
      return true
    },
    hasLiveSession: () => true,
    mirrorEntry: () => idle,
    projects: () => [
      {
        id: 'p1',
        nodes: [
          { id: 'a1', title: 'Alpha', agentId: 'claude' },
          { id: 'b1', title: 'Beta', agentId: 'claude' }
        ]
      }
    ],
    isRemoteNode: () => false,
    // Default: the target (b1) is proven-owned by its store project (p1), so the pure-wiring tests
    // exercise the GRANT, not the ownership gate. Tests that probe ownership override this or use
    // the real ledger via storeDeps.
    paneOwnerProject: () => 'p1',
    messagingEnabled: () => {
      throw new Error('each test wires messagingEnabled itself')
    },
    customAgents: () => undefined,
    appendBoardLog: async () => false,
    subscribeReceipts: (cb) => {
      const t = setTimeout(() => cb({ nodeId: 'b1', newTurn: true, verified: true }), 5)
      return () => clearTimeout(t)
    },
    now: () => 1_000_000,
    ...over
  }
}

const req = { verb: 'send', sourceNodeId: 'a1', targetNodeId: 'b1', body: 'hello' } as never

beforeEach(() => {
  resetMessageFlow()
  resetAgentMessageTraceForTests()
  resetPaneOwnershipForTests()
})

describe('messagingEnabledVia — the grant, never the raw file bit', () => {
  const run = (project: (Partial<Record<'agentMessaging', unknown>> & { capabilityAck?: CapabilityAckMap }) | undefined) =>
    deliverFromControl(
      req,
      baseDeps({ messagingEnabled: messagingEnabledVia(() => project) })
    )

  it('flag true but the clone notice UNANSWERED: refused as switch-off, no pane touched', async () => {
    const deps = baseDeps({ messagingEnabled: messagingEnabledVia(() => ({ agentMessaging: true })) })
    const { outcome, reply } = await deliverFromControl(req, deps)
    expect(outcome).toEqual({ kind: 'notPermitted', reason: 'switch-off' })
    expect(reply.ok).toBe(false)
    expect(deps.sent).toEqual([])
  })

  it('flag true but DECLINED on this machine: still refused — a re-arriving hostile true is not a grant', async () => {
    const { outcome } = await run({ agentMessaging: true, capabilityAck: { agentMessaging: 'declined' } })
    expect(outcome).toEqual({ kind: 'notPermitted', reason: 'switch-off' })
  })

  it('flag true + KEPT: the delivery proceeds all the way to the pane write', async () => {
    const deps = baseDeps({
      messagingEnabled: messagingEnabledVia(() => ({
        agentMessaging: true,
        capabilityAck: { agentMessaging: 'kept' as const }
      }))
    })
    const { outcome, reply } = await deliverFromControl(req, deps)
    expect(outcome.kind).toBe('delivered')
    expect(reply.ok).toBe(true)
    expect(deps.sent).toHaveLength(1)
    expect(deps.sent[0].payload).toContain('hello')
  })

  it('a KEPT ack without the file flag grants nothing — consent alone cannot switch it on', async () => {
    const { outcome } = await run({ capabilityAck: { agentMessaging: 'kept' } })
    expect(outcome).toEqual({ kind: 'notPermitted', reason: 'switch-off' })
  })

  it('an unknown project grants nothing', async () => {
    const { outcome } = await run(undefined)
    expect(outcome).toEqual({ kind: 'notPermitted', reason: 'switch-off' })
  })
})

describe('end to end through a REAL WorkspaceStore — the desktop wiring, minus Electron', () => {
  let userData: string
  let projRoot: string

  const project = (over: Partial<Project> = {}): Project => ({
    id: 'p1',
    name: 'msg',
    color: '#7aa2f7',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [
      { id: 'a1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 'Alpha', color: '#fff', group: null, agentId: 'claude' },
      { id: 'b1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 'Beta', color: '#fff', group: null, agentId: 'claude' }
    ] as Project['nodes'],
    ...over
  })
  const ws = (p: Project): Workspace => ({ version: 2, activeProjectId: p.id, projects: [p] })

  beforeEach(async () => {
    userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-msgsw-'))
    projRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-msgsw-proj-'))
    initPlatform(fakePlatform({ userDataDir: userData }))
  })
  afterEach(async () => {
    resetPlatformForTests()
    await fs.rm(userData, { recursive: true, force: true })
    await fs.rm(projRoot, { recursive: true, force: true })
  })

  /** Exactly the desktop's THREE lines: `projects` off the store, the switch off the store, and
   *  the target's owner off the RUNTIME ledger (never the store). */
  const storeDeps = (store: WorkspaceStore) =>
    baseDeps({
      projects: () => store.persistedCanvases(),
      messagingEnabled: messagingEnabledVia((id) => store.capabilityProjectFor(id)),
      paneOwnerProject: (id) => paneOwnerProject(id)
    })

  it('flag committed in project.json + KEPT + owner PROVEN: delivered', async () => {
    const store = new WorkspaceStore()
    await store.save(
      ws(project({ cwd: projRoot, agentMessaging: true, capabilityAck: { agentMessaging: 'kept' } }))
    )
    // The flag travelled to the git-shared file; the ack did not.
    const raw = await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8')
    expect(raw).toContain('"agentMessaging": true')
    expect(raw).not.toContain('capabilityAck')
    // The runtime fact: this project's own create() freshly spawned the target pane.
    recordFreshSpawnOwner('b1', 'p1')
    const deps = storeDeps(store)
    const { outcome } = await deliverFromControl(req, deps)
    expect(outcome.kind).toBe('delivered')
    expect(deps.sent).toHaveLength(1)
  })

  it('flag committed but the notice never answered: refused as switch-off', async () => {
    const store = new WorkspaceStore()
    await store.save(ws(project({ cwd: projRoot, agentMessaging: true })))
    recordFreshSpawnOwner('b1', 'p1') // ownership proven, so the refusal is the GRANT's, not the gate's
    const deps = storeDeps(store)
    const { outcome } = await deliverFromControl(req, deps)
    expect(outcome).toEqual({ kind: 'notPermitted', reason: 'switch-off' })
    expect(deps.sent).toEqual([])
  })

  it('flag committed but DECLINED on this machine: refused as switch-off', async () => {
    const store = new WorkspaceStore()
    await store.save(
      ws(project({ cwd: projRoot, agentMessaging: true, capabilityAck: { agentMessaging: 'declined' } }))
    )
    recordFreshSpawnOwner('b1', 'p1')
    const { outcome } = await deliverFromControl(req, storeDeps(store))
    expect(outcome).toEqual({ kind: 'notPermitted', reason: 'switch-off' })
  })

  it('a FORGED file-borne capabilityAck is never read: the repo cannot carry this machine\'s consent', async () => {
    // Save without an ack, then let a hostile repo hand-edit the shared file to claim consent.
    const store = new WorkspaceStore()
    await store.save(ws(project({ cwd: projRoot, agentMessaging: true })))
    const filePath = path.join(projRoot, '.nodeterm/project.json')
    const forged = JSON.parse(await fs.readFile(filePath, 'utf-8'))
    forged.capabilityAck = { agentMessaging: 'kept' }
    await fs.writeFile(filePath, JSON.stringify(forged))
    // A fresh app run loads the forged file; the machine-local entry still holds no answer.
    const fresh = new WorkspaceStore()
    await fresh.load()
    recordFreshSpawnOwner('b1', 'p1')
    const { outcome } = await deliverFromControl(req, storeDeps(fresh))
    expect(outcome).toEqual({ kind: 'notPermitted', reason: 'switch-off' })
  })

  it('a hand-edited "true" (string) in the file never enables — the strict read holds through the store', async () => {
    const store = new WorkspaceStore()
    await store.save(ws(project({ cwd: projRoot, capabilityAck: { agentMessaging: 'kept' } })))
    const filePath = path.join(projRoot, '.nodeterm/project.json')
    const edited = JSON.parse(await fs.readFile(filePath, 'utf-8'))
    edited.agentMessaging = 'true'
    await fs.writeFile(filePath, JSON.stringify(edited))
    const fresh = new WorkspaceStore()
    await fresh.load()
    recordFreshSpawnOwner('b1', 'p1')
    const { outcome } = await deliverFromControl(req, storeDeps(fresh))
    expect(outcome).toEqual({ kind: 'notPermitted', reason: 'switch-off' })
  })

  it('CONFUSED DEPUTY (PR #237 review I-1): a granted project cannot reach an UNGRANTED project\'s pane through a duplicated node id', async () => {
    // The reviewer's proved escalation: hostile/cloned project A sets `agentMessaging: true` AND
    // lists a node id that legitimate, ungranted project B is actually running. Panes are keyed by
    // the BARE node id (`nt-<id>`), so pre-fix, once the user kept A's notice, A's grant bought a
    // write into B's one global pane — outcome `delivered`. Now the duplicated target id is
    // refused at scope time with its own name: the pane cannot be attributed to a single
    // project's grant, and A's consent must never speak for B.
    const store = new WorkspaceStore()
    const attacker = project({
      id: 'attacker',
      name: 'cloned-hostile',
      cwd: projRoot,
      agentMessaging: true,
      capabilityAck: { agentMessaging: 'kept' },
      nodes: [
        { id: 'atk-1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 'Atk', color: '#fff', group: null, agentId: 'claude' },
        // The hostile listing: victim-1 is NOT this project's node — it is B's.
        { id: 'victim-1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 'Stolen', color: '#fff', group: null, agentId: 'claude' }
      ] as Project['nodes']
    })
    const victimProject = project({
      id: 'victim-proj',
      name: 'legit-ungranted',
      nodes: [
        { id: 'victim-1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title: 'Victim', color: '#fff', group: null, agentId: 'claude' }
      ] as Project['nodes']
    })
    await store.save({ version: 2, activeProjectId: 'attacker', projects: [attacker, victimProject] })
    const deps = storeDeps(store)
    const { outcome, reply } = await deliverFromControl(
      { verb: 'send', sourceNodeId: 'atk-1', targetNodeId: 'victim-1', body: 'sneak' } as never,
      deps
    )
    expect(outcome).toEqual({ kind: 'notPermitted', reason: 'ambiguous-target-node-id' })
    expect(reply.ok).toBe(false)
    expect(deps.sent).toEqual([]) // NOT delivered — nothing reached any pane
  })

  it('an INLINE (cwd-less) project grants through its entry too', async () => {
    const store = new WorkspaceStore()
    await store.save(
      ws(project({ agentMessaging: true, capabilityAck: { agentMessaging: 'kept' } }))
    )
    recordFreshSpawnOwner('b1', 'p1')
    const deps = storeDeps(store)
    const { outcome } = await deliverFromControl(req, deps)
    expect(outcome.kind).toBe('delivered')
  })
})

describe('runtime pane-ownership gate (PR #237 fix round 2) — over a REAL store + ledger', () => {
  let userData: string
  let projRoot: string

  const project = (over: Partial<Project> = {}): Project => ({
    id: 'p1',
    name: 'msg',
    color: '#7aa2f7',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [] as Project['nodes'],
    ...over
  })
  const node = (id: string, title: string) =>
    ({ id, kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 1, height: 1 }, title, color: '#fff', group: null, agentId: 'claude' })
  const ws2 = (p: Project): Workspace => ({ version: 2, activeProjectId: p.id, projects: [p] })

  beforeEach(async () => {
    userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-own-'))
    projRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-own-proj-'))
    initPlatform(fakePlatform({ userDataDir: userData }))
  })
  afterEach(async () => {
    resetPlatformForTests()
    await fs.rm(userData, { recursive: true, force: true })
    await fs.rm(projRoot, { recursive: true, force: true })
  })

  const storeDeps = (store: WorkspaceStore) =>
    baseDeps({
      projects: () => store.persistedCanvases(),
      messagingEnabled: messagingEnabledVia((id) => store.capabilityProjectFor(id)),
      paneOwnerProject: (id) => paneOwnerProject(id)
    })

  it('FAIL-OPEN CLOSED: victim project ABSENT from the store, its pane live — granted attacker listing the id is REFUSED, not delivered', async () => {
    // The re-review's Critical, driven end to end. Project A is granted+kept and its (hostile)
    // project.json is the SOLE store claimant of `victim-1` — the real owner B is not persisted at
    // all, so the round-1 ambiguity check (which needs two store claimants) does NOT fire and scope
    // resolves same-project=A. Pre-round-2 the switch then passed on A and the envelope reached
    // victim-1's one global pane (outcome=delivered, reply.ok=true). Now the RUNTIME ledger is the
    // authority: victim-1 was freshly spawned by B this run, so its proven owner is 'victim-proj',
    // which is NOT A — refused, nothing written.
    const store = new WorkspaceStore()
    const attacker = project({
      id: 'attacker',
      name: 'cloned-hostile',
      cwd: projRoot,
      agentMessaging: true,
      capabilityAck: { agentMessaging: 'kept' },
      nodes: [node('atk-1', 'Atk'), node('victim-1', 'Stolen')] as Project['nodes']
    })
    // Victim B is NOT in the persisted store — only its pane runs. That is the whole point.
    await store.save({ version: 2, activeProjectId: 'attacker', projects: [attacker] })
    recordFreshSpawnOwner('victim-1', 'victim-proj') // B's create() genuinely spawned it this run
    const deps = storeDeps(store)
    const { outcome, reply } = await deliverFromControl(
      { verb: 'send', sourceNodeId: 'atk-1', targetNodeId: 'victim-1', body: 'sneak' } as never,
      deps
    )
    expect(outcome).toEqual({ kind: 'notPermitted', reason: 'unproven-target-owner' })
    expect(reply.ok).toBe(false)
    expect(deps.sent).toEqual([]) // NOTHING reached the victim's pane
  })

  it('LEDGER EMPTY (post-restart re-attach): a live pane with no runtime owner is UNPROVEN → refused', async () => {
    // After an app restart the tmux server survives, the renderer re-ATTACHES (fresh===false, so
    // nothing is recorded), and the ledger is empty. A pane in that state is unproven and must be
    // refused — the fail-closed cold-state direction. (Same store shape as the attack, minus the
    // ledger record.)
    const store = new WorkspaceStore()
    const attacker = project({
      id: 'attacker',
      name: 'cloned-hostile',
      cwd: projRoot,
      agentMessaging: true,
      capabilityAck: { agentMessaging: 'kept' },
      nodes: [node('atk-1', 'Atk'), node('victim-1', 'Stolen')] as Project['nodes']
    })
    await store.save({ version: 2, activeProjectId: 'attacker', projects: [attacker] })
    // resetPaneOwnershipForTests() in beforeEach already emptied it; record NOTHING.
    const deps = storeDeps(store)
    const { outcome } = await deliverFromControl(
      { verb: 'send', sourceNodeId: 'atk-1', targetNodeId: 'victim-1', body: 'x' } as never,
      deps
    )
    expect(outcome).toEqual({ kind: 'notPermitted', reason: 'unproven-target-owner' })
    expect(deps.sent).toEqual([])
  })

  it('LEGITIMATE self-delivery: a project messaging a node IT freshly spawned, granted+kept → delivered', async () => {
    // Proves the fix is not "refuse everything": when the ledger owner matches the store project
    // AND that project holds the grant, the delivery proceeds to the pane write.
    const store = new WorkspaceStore()
    await store.save(
      ws2(
        project({
          id: 'p1',
          cwd: projRoot,
          agentMessaging: true,
          capabilityAck: { agentMessaging: 'kept' },
          nodes: [node('a1', 'Alpha'), node('b1', 'Beta')] as Project['nodes']
        })
      )
    )
    recordFreshSpawnOwner('b1', 'p1') // p1's own create() spawned b1
    const deps = storeDeps(store)
    const { outcome } = await deliverFromControl(
      { verb: 'send', sourceNodeId: 'a1', targetNodeId: 'b1', body: 'hi' } as never,
      deps
    )
    expect(outcome.kind).toBe('delivered')
    expect(deps.sent).toHaveLength(1)
  })

  it('ledger owner DISAGREES with the sole store claimant → refused even when that claimant is granted', async () => {
    // The cross-check leg: the store says p1 owns b1 and p1 is granted, but the RUNTIME ledger
    // says someone else spawned b1 (a stale/forged store claim over a live foreign pane). The
    // disagreement itself is disqualifying — the grant of a project that did not spawn the pane
    // cannot authorize a write into it.
    const store = new WorkspaceStore()
    await store.save(
      ws2(
        project({
          id: 'p1',
          cwd: projRoot,
          agentMessaging: true,
          capabilityAck: { agentMessaging: 'kept' },
          nodes: [node('a1', 'Alpha'), node('b1', 'Beta')] as Project['nodes']
        })
      )
    )
    recordFreshSpawnOwner('b1', 'someone-else')
    const deps = storeDeps(store)
    const { outcome } = await deliverFromControl(
      { verb: 'send', sourceNodeId: 'a1', targetNodeId: 'b1', body: 'hi' } as never,
      deps
    )
    expect(outcome).toEqual({ kind: 'notPermitted', reason: 'unproven-target-owner' })
    expect(deps.sent).toEqual([])
  })
})
