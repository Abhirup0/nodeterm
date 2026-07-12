import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { IPC } from '../shared/ipc'

/** One fake pty per spawn, recorded so a test can assert "exactly one spawn" and push output. */
interface FakePty {
  onDataCb?: (d: string) => void
  onExitCb?: (e: { exitCode: number }) => void
  writes: string[]
  resizes: Array<{ cols: number; rows: number }>
  paused: boolean
  killed: boolean
}
const spawned: FakePty[] = []
/** When set, the NEXT pty.spawn throws (simulates posix_spawn failing). */
let failNextSpawn = false

vi.mock('node-pty', () => ({
  spawn: (_file: string, _args: string[], _opts: unknown) => {
    if (failNextSpawn) {
      failNextSpawn = false
      throw new Error('posix_spawnp failed.')
    }
    const p: FakePty = { writes: [], resizes: [], paused: false, killed: false }
    spawned.push(p)
    return {
      onData: (cb: (d: string) => void) => {
        p.onDataCb = cb
      },
      onExit: (cb: (e: { exitCode: number }) => void) => {
        p.onExitCb = cb
      },
      write: (d: string) => p.writes.push(d),
      resize: (cols: number, rows: number) => p.resizes.push({ cols, rows }),
      pause: () => {
        p.paused = true
      },
      resume: () => {
        p.paused = false
      },
      kill: () => {
        p.killed = true
      },
      pid: 1234
    }
  }
}))

const ALICE = 1
const BOB = 2

describe('terminal co-attach: one PTY, N subscribers', () => {
  let fake: FakePlatform

  beforeEach(() => {
    spawned.length = 0
    failNextSpawn = false
    fake = fakePlatform()
    initPlatform(fake)
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
    resetPlatformForTests()
  })

  async function manager() {
    const { PtyManager } = await import('./pty-manager')
    const m = new PtyManager()
    m.registerIpc()
    return m
  }
  const create = (clientId: number, cols = 80, rows = 24, persistKey = 'node-1') =>
    fake.handlers[IPC.ptyCreate](clientId, { cols, rows, persistKey }) as Promise<{
      sessionId: string
      fresh: boolean
    }>
  // pty:kill is sender-aware (it unsubscribes ONE client), so it lands in senderListeners.
  const kill = (clientId: number, sessionId: string) =>
    fake.senderListeners[IPC.ptyKill](clientId, sessionId)

  it('a second client on the same persistKey subscribes instead of spawning', async () => {
    await manager()
    const a = await create(ALICE)
    const b = await create(BOB)

    expect(spawned).toHaveLength(1) // ONE pty, ONE tmux client
    expect(b.sessionId).toBe(a.sessionId)
    expect(a.fresh).toBe(true) // Alice created it
    expect(b.fresh).toBe(false) // Bob joined a live session — no cold-restore replay
  })

  it('output fans out to every subscriber', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)

    spawned[0].onDataCb?.('hello')
    vi.advanceTimersByTime(20) // FLUSH_MS coalescing window

    const data = fake.sent.filter((s) => s.channel === IPC.ptyData(sessionId))
    expect(data.map((s) => s.to).sort()).toEqual([ALICE, BOB])
    expect(data.every((s) => s.args[0] === 'hello')).toBe(true)
  })

  it('exit fans out to every subscriber and clears the persistKey index', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)

    spawned[0].onExitCb?.({ exitCode: 7 })
    const exits = fake.sent.filter((s) => s.channel === IPC.ptyExit(sessionId))
    expect(exits.map((s) => s.to).sort()).toEqual([ALICE, BOB])
    expect(exits.every((s) => s.args[0] === 7)).toBe(true)

    // The session is gone, so a fresh create must spawn again (not hand out a dead sessionId).
    await create(ALICE)
    expect(spawned).toHaveLength(2)
  })

  it('kill unsubscribes ONE client; the pty survives while others watch', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)

    kill(ALICE, sessionId) // Alice closes her tab
    fake.sent.length = 0
    spawned[0].onDataCb?.('still here')
    vi.advanceTimersByTime(20)

    const data = fake.sent.filter((s) => s.channel === IPC.ptyData(sessionId))
    expect(data.map((s) => s.to)).toEqual([BOB]) // Bob still gets output
    expect(spawned[0].killed).toBe(false) // pty untouched

    // Bob leaves too → last subscriber out releases the pty.
    kill(BOB, sessionId)
    expect(spawned[0].killed).toBe(true)
  })

  it('the last subscriber leaving un-indexes the node, so the next create spawns', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    kill(ALICE, sessionId)

    const again = await create(ALICE)
    expect(spawned).toHaveLength(2)
    expect(again.sessionId).not.toBe(sessionId)
  })

  it('writes from any subscriber reach the one pty (no locking — they interleave)', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    fake.listeners[IPC.ptyWrite](sessionId, 'a')
    fake.listeners[IPC.ptyWrite](sessionId, 'b')
    expect(spawned[0].writes).toEqual(['a', 'b'])
  })

  it('a destroyed node is never co-attached to (the × path un-indexes it)', async () => {
    const m = await manager()
    const first = await create(ALICE)
    await m.destroySession('node-1') // user clicked ×: the tmux session is gone for good

    const second = await create(BOB)
    expect(second.sessionId).not.toBe(first.sessionId)
    expect(spawned).toHaveLength(2)
  })

  it('a relay-served (detached) pty is NOT indexed: it keeps its own session', async () => {
    const m = await manager()
    const chunks: string[] = []
    const detachedId = m.attachDetached('node-1', {
      onData: (d) => chunks.push(d),
      onExit: () => {}
    })
    // The host's detached pty must not be handed to a UI client asking for the same node.
    const ui = await create(ALICE)
    expect(ui.sessionId).not.toBe(detachedId)
    expect(spawned).toHaveLength(2)

    // The detached sink still receives its own session's output (relay path unchanged).
    spawned[0].onDataCb?.('host output')
    vi.advanceTimersByTime(20)
    expect(chunks).toEqual(['host output'])
  })

  it('the relay releases its detached pty via kill(null, …) even with no subscribers', async () => {
    const m = await manager()
    const id = m.attachDetached('node-1', { onData: () => {}, onExit: () => {} })
    m.kill(null, id)
    expect(spawned[0].killed).toBe(true)
  })

  // ── Finding 1: a joiner must never inherit a PAUSED pty ────────────────────────────────
  // Flow control is per-client in the renderer (xterm backlog > 1 MB → setFlow(false)) and its
  // `paused` flag only clears when more data arrives. So a pty left paused by a client that
  // vanished can never be resumed by a new one: it would show a blank, frozen terminal forever.
  it('a client joining a PAUSED session resumes the pty (an empty backlog cannot resume it)', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    fake.listeners[IPC.ptyFlow](sessionId, false) // Alice's xterm backlog crossed the high water mark
    expect(spawned[0].paused).toBe(true)

    // Alice's browser tab is gone (or reloaded): a new client co-attaches to the same node.
    const bob = await create(BOB)
    expect(bob.sessionId).toBe(sessionId)
    expect(spawned[0].paused).toBe(false) // a joiner has an empty backlog by definition
  })

  it('a departing client cannot leave the pty paused for the subscribers that stay', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    fake.listeners[IPC.ptyFlow](sessionId, false)
    expect(spawned[0].paused).toBe(true)

    kill(ALICE, sessionId) // the client that paused it leaves
    expect(spawned[0].paused).toBe(false) // Bob's terminal keeps streaming
  })

  // ── Finding 2: a client that vanishes (WS close / destroyed webContents) is dropped ──────
  it('dropClient unsubscribes the client from EVERY session and releases the empty ones', async () => {
    const m = await manager()
    const shared = await create(ALICE, 80, 24, 'node-1')
    await create(BOB, 80, 24, 'node-1')
    const solo = await create(ALICE, 80, 24, 'node-2')

    m.dropClient(ALICE) // Alice's browser tab closed — no pty:kill ever arrives

    // node-1 still has Bob: the pty survives and keeps fanning out to him only.
    fake.sent.length = 0
    spawned[0].onDataCb?.('still here')
    vi.advanceTimersByTime(20)
    const data = fake.sent.filter((s) => s.channel === IPC.ptyData(shared.sessionId))
    expect(data.map((s) => s.to)).toEqual([BOB])
    expect(spawned[0].killed).toBe(false)

    // node-2 fell to zero subscribers: the pty client is released (the tmux session survives).
    expect(spawned[1].killed).toBe(true)
    const again = await create(BOB, 80, 24, 'node-2')
    expect(again.sessionId).not.toBe(solo.sessionId)
    expect(spawned).toHaveLength(3)
  })

  it('dropClient resumes a session the vanished client had paused', async () => {
    const m = await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    fake.listeners[IPC.ptyFlow](sessionId, false)

    m.dropClient(ALICE)
    expect(spawned[0].paused).toBe(false)
    expect(spawned[0].killed).toBe(false)
  })

  it('dropClient leaves a relay-served (detached) pty alone', async () => {
    const m = await manager()
    const id = m.attachDetached('node-1', { onData: () => {}, onExit: () => {} })
    m.dropClient(ALICE)
    expect(spawned[0].killed).toBe(false)
    m.kill(null, id)
    expect(spawned[0].killed).toBe(true)
  })

  // ── Finding 3: the same-tick create race ────────────────────────────────────────────────
  // create() awaits a `tmux has-session` subprocess + the shell-PATH probe between the index
  // lookup and spawnSession's synchronous registration, so two clients opening the same node
  // in that window both used to spawn — and the second `tmux -A -D` kicked the first viewer off.
  it('two overlapping creates for the same node resolve to ONE spawn', async () => {
    await manager()
    const [a, b] = await Promise.all([create(ALICE), create(BOB)])

    expect(spawned).toHaveLength(1)
    expect(b.sessionId).toBe(a.sessionId)
    expect(a.fresh).toBe(true) // Alice's call did the spawn
    expect(b.fresh).toBe(false) // Bob joined it — no cold-restore replay
  })

  it('a failed spawn clears the in-flight entry, so the node stays openable', async () => {
    await manager()
    failNextSpawn = true
    await expect(create(ALICE)).rejects.toThrow(/Failed to spawn terminal/)

    const ok = await create(ALICE)
    expect(ok.sessionId).toBeTruthy()
    expect(spawned).toHaveLength(1)
  })

  it('a create racing a failed spawn still gets a live session', async () => {
    await manager()
    failNextSpawn = true
    const [a, b] = await Promise.allSettled([create(ALICE), create(BOB)])
    expect(a.status).toBe('rejected')
    expect(b.status).toBe('fulfilled')
    expect(spawned).toHaveLength(1) // Bob's create spawned after the failure cleared the entry
  })
})

describe('tmuxAttachFlags', () => {
  it("keeps -D for the app's own client: exactly ONE tmux client per session", async () => {
    const { tmuxAttachFlags } = await import('./pty-manager')
    // Co-attach adds subscribers to OUR session — it never adds a tmux client, so -D stays.
    expect(tmuxAttachFlags(false)).toEqual(['-A', '-D'])
    // A relay-served (detached) pty mirrors the host's own client → must NOT detach it.
    expect(tmuxAttachFlags(true)).toEqual(['-A'])
  })
})
