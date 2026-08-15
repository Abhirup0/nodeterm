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
    sendFramedPayload: async (nodeId, payload) => {
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

  /** Exactly the desktop's two lines: `projects` off the store, the switch off the store. */
  const storeDeps = (store: WorkspaceStore) =>
    baseDeps({
      projects: () => store.persistedCanvases(),
      messagingEnabled: messagingEnabledVia((id) => store.capabilityProjectFor(id))
    })

  it('flag committed in project.json + KEPT on this machine: delivered', async () => {
    const store = new WorkspaceStore()
    await store.save(
      ws(project({ cwd: projRoot, agentMessaging: true, capabilityAck: { agentMessaging: 'kept' } }))
    )
    // The flag travelled to the git-shared file; the ack did not.
    const raw = await fs.readFile(path.join(projRoot, '.nodeterm/project.json'), 'utf-8')
    expect(raw).toContain('"agentMessaging": true')
    expect(raw).not.toContain('capabilityAck')
    const deps = storeDeps(store)
    const { outcome } = await deliverFromControl(req, deps)
    expect(outcome.kind).toBe('delivered')
    expect(deps.sent).toHaveLength(1)
  })

  it('flag committed but the notice never answered: refused as switch-off', async () => {
    const store = new WorkspaceStore()
    await store.save(ws(project({ cwd: projRoot, agentMessaging: true })))
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
    const deps = storeDeps(store)
    const { outcome } = await deliverFromControl(req, deps)
    expect(outcome.kind).toBe('delivered')
  })
})
