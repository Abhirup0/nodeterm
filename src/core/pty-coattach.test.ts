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
const CAROL = 3

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
      closed?: { by: number | null }
    }>
  // pty:kill is sender-aware (it unsubscribes ONE client), so it lands in senderListeners.
  const kill = (clientId: number, sessionId: string) =>
    fake.senderListeners[IPC.ptyKill](clientId, sessionId)
  // pty:flow is sender-aware too: a pause is OWED by the client whose xterm backlog overflowed,
  // so it can only be returned by that client (or by its departure).
  const flow = (clientId: number, sessionId: string, resume: boolean) =>
    fake.senderListeners[IPC.ptyFlow](clientId, sessionId, resume)
  // pty:write is sender-aware as well: with one pty and N subscribers, a keystroke has to carry WHO
  // typed it — that is what badges the node as "X is typing" (see pty-typing.test.ts).
  const write = (clientId: number, sessionId: string, data: string) =>
    fake.senderListeners[IPC.ptyWrite](clientId, sessionId, data)

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
    write(ALICE, sessionId, 'a')
    write(BOB, sessionId, 'b')
    expect(spawned[0].writes).toEqual(['a', 'b'])
  })

  it('a destroyed node is never co-attached to, and never respawned (the × path un-indexes + tombstones it)', async () => {
    const m = await manager()
    await create(ALICE)
    await m.destroySession(ALICE, 'node-1') // user clicked ×: the tmux session is gone for good

    const second = await create(BOB)
    expect(second.sessionId).toBe('') // neither the dead session…
    expect(second.closed).toEqual({ by: ALICE }) // …nor a fresh one: the node is gone
    expect(spawned).toHaveLength(1)
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

  // ── Flow control is OWED PER CLIENT (`pausedBy`) ─────────────────────────────────────────
  // Two invariants, and a single `paused` boolean per session can only ever satisfy one of them:
  //  (a) a pause owed by a client that LEFT is always returned  → nobody is frozen forever;
  //  (b) a pause owed by a client that is STILL HERE is never silently cancelled → its renderer's
  //      write queue cannot grow without bound (its flow control is EDGE-latched: once it has
  //      pumped `setFlow(false)` it will not re-pause, so a resume behind its back is permanent).
  it('a solo client pauses and resumes its own pty (single-user path unchanged)', async () => {
    await manager()
    const { sessionId } = await create(ALICE)

    flow(ALICE, sessionId, false)
    expect(spawned[0].paused).toBe(true)
    flow(ALICE, sessionId, true)
    expect(spawned[0].paused).toBe(false)
  })

  it('a client joining a session PAUSED by a client that left resumes the pty', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    flow(ALICE, sessionId, false) // Alice's xterm backlog crossed the high water mark
    expect(spawned[0].paused).toBe(true)

    // Alice's tab is gone; her renderer reloads (same client id) and re-creates the node. Her new
    // page has an empty backlog, so it will never send the resume her old page owed us.
    const again = await create(ALICE)
    expect(again.sessionId).toBe(sessionId)
    expect(spawned[0].paused).toBe(false)
  })

  it('a departing client cannot leave the pty paused for the subscribers that stay', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    flow(ALICE, sessionId, false)
    expect(spawned[0].paused).toBe(true)

    kill(ALICE, sessionId) // the client that paused it leaves
    expect(spawned[0].paused).toBe(false) // Bob's terminal keeps streaming
  })

  it('a DIFFERENT client joining does NOT cancel a pause the drowning client still owes', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    flow(ALICE, sessionId, false) // Alice is 1 MB behind a `yes`-grade flood
    expect(spawned[0].paused).toBe(true)

    await create(BOB) // Bob opens the same node — Alice is still drowning
    expect(spawned[0].paused).toBe(true) // resuming here would grow Alice's queue without bound

    flow(ALICE, sessionId, true) // Alice drains → the last owed resume lands
    expect(spawned[0].paused).toBe(false)
  })

  it('a DIFFERENT client leaving does NOT cancel a pause the drowning client still owes', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    flow(ALICE, sessionId, false)

    kill(BOB, sessionId) // Bob closes his tab; Alice is still behind
    expect(spawned[0].paused).toBe(true)
    expect(spawned[0].killed).toBe(false)
  })

  it('the pty resumes only when the LAST owed resume lands', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    flow(ALICE, sessionId, false)
    flow(BOB, sessionId, false)
    expect(spawned[0].paused).toBe(true)

    flow(ALICE, sessionId, true)
    expect(spawned[0].paused).toBe(true) // Bob is still behind
    flow(BOB, sessionId, true)
    expect(spawned[0].paused).toBe(false)
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
    flow(ALICE, sessionId, false)

    m.dropClient(ALICE)
    expect(spawned[0].paused).toBe(false)
    expect(spawned[0].killed).toBe(false)
  })

  it('dropClient leaves a pause another (still present) client owes in place', async () => {
    const m = await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    flow(ALICE, sessionId, false)

    m.dropClient(BOB) // Bob's tab vanished; Alice is still drowning
    expect(spawned[0].paused).toBe(true)
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

  // TWO racers behind ONE failed spawn: the first survivor re-spawns, and the second must see
  // THAT spawn in `inflight` (the entry it awaited is long gone) instead of spawning again — a
  // second `tmux -A -D` would detach the first survivor's client, which is the very race the
  // in-flight guard exists to prevent.
  it('two creates racing a failed spawn resolve to ONE session, not two', async () => {
    await manager()
    failNextSpawn = true
    const [a, b, c] = await Promise.allSettled([create(ALICE), create(BOB), create(CAROL)])
    expect(a.status).toBe('rejected')
    expect(b.status).toBe('fulfilled')
    expect(c.status).toBe('fulfilled')
    expect(spawned).toHaveLength(1)
    const bId = b.status === 'fulfilled' ? b.value.sessionId : 'b'
    const cId = c.status === 'fulfilled' ? c.value.sessionId : 'c'
    expect(cId).toBe(bId)
  })
})

describe('size negotiation: smallest subscriber wins', () => {
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
  const create = (clientId: number, cols: number, rows: number, persistKey = 'node-1') =>
    fake.handlers[IPC.ptyCreate](clientId, { cols, rows, persistKey }) as Promise<{
      sessionId: string
      fresh: boolean
    }>
  // pty:resize is sender-aware now (a size must be attributed to the client that reported it).
  const resize = (
    clientId: number,
    sessionId: string,
    cols: number | null,
    rows: number | null
  ) => fake.senderListeners[IPC.ptyResize](clientId, sessionId, cols, rows)
  const kill = (clientId: number, sessionId: string) =>
    fake.senderListeners[IPC.ptyKill](clientId, sessionId)
  const sizes = (sessionId: string) =>
    fake.sent.filter((s) => s.channel === IPC.ptySize(sessionId))

  it('runs the pty at min(cols) x min(rows) and broadcasts it to every subscriber', async () => {
    await manager()
    const { sessionId } = await create(ALICE, 120, 40)
    fake.sent.length = 0
    await create(BOB, 80, 60) // narrower but taller

    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 80, rows: 40 })
    const sent = sizes(sessionId)
    expect(sent.map((s) => s.to).sort()).toEqual([ALICE, BOB])
    expect(sent.every((s) => s.args[0].cols === 80 && s.args[0].rows === 40)).toBe(true)
  })

  it('a joiner bigger than the pty is told the authoritative size (nothing is resized)', async () => {
    await manager()
    const { sessionId } = await create(ALICE, 80, 24)
    fake.sent.length = 0
    await create(BOB, 120, 40)

    // The pty already runs at 80x24 (Alice spawned it there) — do not make tmux redraw for nothing.
    expect(spawned[0].resizes).toEqual([])
    // Bob's xterm fitted itself to 120x40, so he MUST be told to render 80x24 and letterbox.
    const sent = sizes(sessionId)
    expect(sent.map((s) => s.to)).toEqual([BOB]) // Alice already renders 80x24 — no message for her
    expect(sent[0].args[0]).toEqual({ cols: 80, rows: 24 })
  })

  it('a subscriber growing its window does not grow the pty past the smaller peer', async () => {
    await manager()
    const { sessionId } = await create(ALICE, 80, 24)
    await create(BOB, 120, 40)
    fake.sent.length = 0
    resize(BOB, sessionId, 200, 80) // Bob maximizes

    expect(spawned[0].resizes.every((r) => r.cols <= 80 && r.rows <= 24)).toBe(true)
    // Bob's own fit is not authoritative: he is told (again) to render Alice's size.
    const sent = sizes(sessionId)
    expect(sent.map((s) => s.to)).toEqual([BOB])
    expect(sent[0].args[0]).toEqual({ cols: 80, rows: 24 })
  })

  it('when the smallest subscriber leaves, the pty grows back to the remaining one', async () => {
    await manager()
    const { sessionId } = await create(ALICE, 80, 24)
    await create(BOB, 120, 40)

    fake.sent.length = 0
    kill(ALICE, sessionId)
    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 120, rows: 40 })
    const sent = sizes(sessionId)
    expect(sent.map((s) => s.to)).toEqual([BOB])
    expect(sent[0].args[0]).toEqual({ cols: 120, rows: 40 })
  })

  // ── The single-user path must stay bit-for-bit identical ─────────────────────────────────
  it('a solo subscriber resizes the pty to its own size, with no pty:size traffic at all', async () => {
    await manager()
    const { sessionId } = await create(ALICE, 80, 24)
    fake.sent.length = 0

    resize(ALICE, sessionId, 100, 30)
    expect(spawned[0].resizes).toEqual([{ cols: 100, rows: 30 }]) // min(one) is Alice's own size
    // Alice already renders what she asked for: telling her would be pure round-trip noise.
    expect(sizes(sessionId)).toEqual([])

    // Same fit reported twice (a ResizeObserver tick that changed nothing) → no second ioctl.
    resize(ALICE, sessionId, 100, 30)
    expect(spawned[0].resizes).toHaveLength(1)
  })

  // ── A PARKED terminal is subscribed but not looking ──────────────────────────────────────
  // The renderer keeps a node's xterm+PTY alive for 5 minutes after unmount (TERM_PARK_MS), so a
  // parked client stays a subscriber. Its (possibly tiny) last fit must NOT shrink the terminal
  // for the people still watching — it reports a null size instead: "listening, not viewing".
  it('a parked subscriber (null size) stops constraining the shared pty but keeps its output', async () => {
    await manager()
    const { sessionId } = await create(ALICE, 80, 24)
    await create(BOB, 120, 40)
    fake.sent.length = 0

    resize(ALICE, sessionId, null, null) // Alice's node unmounted → parked
    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 120, rows: 40 }) // Bob gets his full size back
    expect(sizes(sessionId).map((s) => s.to).sort()).toEqual([ALICE, BOB])

    // Parked ≠ gone: the parked xterm keeps consuming output (that is what makes re-adoption exact).
    fake.sent.length = 0
    spawned[0].onDataCb?.('still streaming')
    vi.advanceTimersByTime(20)
    const data = fake.sent.filter((s) => s.channel === IPC.ptyData(sessionId))
    expect(data.map((s) => s.to).sort()).toEqual([ALICE, BOB])

    // Un-parking (re-adopt → fresh fit) makes her constrain again.
    resize(ALICE, sessionId, 80, 24)
    expect(spawned[0].resizes.at(-1)).toEqual({ cols: 80, rows: 24 })
  })

  it('a parked SOLO subscriber leaves the pty size alone (nobody is left to size it)', async () => {
    await manager()
    const { sessionId } = await create(ALICE, 80, 24)
    fake.sent.length = 0

    resize(ALICE, sessionId, null, null)
    expect(spawned[0].resizes).toEqual([]) // no viewers → keep the last size, never resize to 1x1
    expect(sizes(sessionId)).toEqual([])
  })
})

// ── A node DELETED while somebody else is watching it ─────────────────────────────────────────
// The × button means "this terminal is gone for good" (tmux kill-session). With co-attach the
// node may have other viewers, and the one thing they must NOT do is quietly reopen it: a respawn
// would resurrect a session its owner deliberately destroyed — in a fresh shell, with none of the
// state, and leaving a stray tmux session behind. They are told WHO closed it instead, and land in
// a closed state (the renderer paints "closed by <name>" from the presence table — Tasks 9-10).
describe('node destroyed while co-viewed', () => {
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
  const create = (clientId: number, persistKey = 'node-1') =>
    fake.handlers[IPC.ptyCreate](clientId, { cols: 80, rows: 24, persistKey }) as Promise<{
      sessionId: string
      fresh: boolean
      closed?: { by: number | null }
    }>
  // pty:destroy is sender-aware: the closed event has to name WHO pressed ×.
  const destroy = (clientId: number, persistKey = 'node-1') =>
    fake.senderListeners[IPC.ptyDestroy](clientId, persistKey) as unknown as Promise<void>
  const flow = (clientId: number, sessionId: string, resume: boolean) =>
    fake.senderListeners[IPC.ptyFlow](clientId, sessionId, resume)
  const closed = (sessionId: string) =>
    fake.sent.filter((s) => s.channel === IPC.ptyClosed(sessionId))

  it('tells the OTHER subscribers who closed it, and does not respawn', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)

    fake.sent.length = 0
    await destroy(ALICE) // Alice hits the × on the node

    expect(closed(sessionId).map((s) => s.to)).toEqual([BOB]) // the closer does not need telling
    expect(closed(sessionId)[0].args[0]).toEqual({ by: ALICE })
    expect(spawned[0].killed).toBe(true) // the pty client is released with the session
    expect(spawned).toHaveLength(1) // …and nothing respawned it
  })

  // The `pty:closed` event only reaches SUBSCRIBERS. A co-viewer whose project is inactive/closed
  // has no mounted terminal, is not subscribed, and hears nothing — its canvas still has the node,
  // so opening that project later would `create` it and RESURRECT a terminal its owner deliberately
  // deleted, in a fresh shell. The tombstone is what makes that create refuse instead of spawn.
  it('a create by ANOTHER client after the destroy is refused — it never resurrects the node', async () => {
    await manager()
    await create(ALICE)
    await create(BOB)
    await destroy(ALICE)

    const again = await create(BOB)
    expect(again.closed).toEqual({ by: ALICE }) // "closed by Alice", not a brand-new shell
    expect(again.sessionId).toBe('')
    expect(spawned).toHaveLength(1) // …and nothing was spawned
  })

  it('a create by a client that never saw the destroy is refused too (unsubscribed co-viewer)', async () => {
    await manager()
    await create(ALICE)
    await destroy(ALICE) // Carol was not watching — she got no pty:closed

    const carol = await create(CAROL)
    expect(carol.closed).toEqual({ by: ALICE })
    expect(spawned).toHaveLength(1)
  })

  it('the client that DELETED the node may still respawn it (undo) — and that clears the tombstone', async () => {
    await manager()
    await create(ALICE)
    await destroy(ALICE)

    // ⌘Z restores the node on Alice's canvas: her own re-create must spawn, exactly as it always
    // did (the single-user delete→undo path is untouched by the tombstone).
    const undone = await create(ALICE)
    expect(undone.closed).toBeUndefined()
    expect(undone.fresh).toBe(true)
    expect(spawned).toHaveLength(2)
    // The node is alive again, so a co-viewer must be able to join it rather than stay tombstoned.
    const bob = await create(BOB)
    expect(bob.sessionId).toBe(undone.sessionId)
  })

  it('a RECYCLE (worktree move) leaves no tombstone — the node is not deleted', async () => {
    await manager()
    await create(ALICE)
    await create(BOB)
    await (fake.senderListeners[IPC.ptyRecycle](ALICE, 'node-1') as unknown as Promise<void>)

    const again = await create(ALICE) // the mover respawns in the new cwd
    expect(again.closed).toBeUndefined()
    const bob = await create(BOB) // and the co-viewer joins it
    expect(bob.sessionId).toBe(again.sessionId)
    expect(spawned).toHaveLength(2)
  })

  it('the destroyed session stops fanning out: no data, and no exit after the close', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    await destroy(ALICE)

    fake.sent.length = 0
    spawned[0].onDataCb?.('ghost output') // the pty client is being torn down
    vi.advanceTimersByTime(20)
    spawned[0].onExitCb?.({ exitCode: 1 }) // …and its exit lands after the close event
    expect(fake.sent.filter((s) => s.channel === IPC.ptyData(sessionId))).toEqual([])
    // "[process exited with code 1]" on top of "closed by Alice" would be noise at best: the
    // subscribers were told the truth already, and the session is off the books.
    expect(fake.sent.filter((s) => s.channel === IPC.ptyExit(sessionId))).toEqual([])
  })

  it('releases a session a subscriber had PAUSED (a dying pty must not keep its fd)', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    flow(BOB, sessionId, false) // Bob's xterm is drowning — the pty is paused for everyone
    expect(spawned[0].paused).toBe(true)

    await destroy(ALICE)
    // releasePty resumes before destroying: a paused pty never reads EOF, so it would otherwise
    // leak its master fd (see pty-release.ts). Bob owes a resume that will never come — the
    // session is gone, so the ledger goes with it.
    expect(spawned[0].paused).toBe(false)
    expect(spawned[0].killed).toBe(true)
    expect(closed(sessionId).map((s) => s.to)).toEqual([BOB])
  })

  it('a destroy with no live session still tells nobody and kills the tmux session', async () => {
    await manager()
    // Nothing was ever created for node-9 in this process (e.g. it is only running in tmux).
    await destroy(ALICE, 'node-9')
    expect(fake.sent).toEqual([])
    expect(spawned).toHaveLength(0)
  })
})

// ── A node RECYCLED (moved into a worktree) while somebody else is watching it ────────────────
// "Move into worktree" ends the node's tmux session so the SAME node id respawns in the new cwd.
// The node never leaves anybody's canvas and it keeps working — so a co-viewer must NOT be told
// "closed by <name>" (which is permanent and un-respawnable). They are told the session RESTARTED,
// and only once the replacement session exists: notify them any earlier and their own re-create
// could win the race and spawn the tmux session in their STALE cwd, silently undoing the move.
describe('node recycled (worktree move) while co-viewed', () => {
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
  const create = (clientId: number, persistKey = 'node-1') =>
    fake.handlers[IPC.ptyCreate](clientId, { cols: 80, rows: 24, persistKey }) as Promise<{
      sessionId: string
      fresh: boolean
    }>
  // pty:recycle is sender-aware: the client that recycled drives its OWN respawn, so it must be
  // excluded from the restart notice (it would otherwise respawn twice).
  const recycle = (clientId: number, persistKey = 'node-1') =>
    fake.senderListeners[IPC.ptyRecycle](clientId, persistKey) as unknown as Promise<void>
  const closed = (sessionId: string) =>
    fake.sent.filter((s) => s.channel === IPC.ptyClosed(sessionId))
  const recycled = (sessionId: string) =>
    fake.sent.filter((s) => s.channel === IPC.ptyRecycled(sessionId))

  it('never tells a co-viewer the node was CLOSED — it is still on their canvas', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)

    fake.sent.length = 0
    await recycle(ALICE)
    expect(closed(sessionId)).toEqual([]) // the un-respawnable "closed by <name>" state must NOT fire
    expect(spawned[0].killed).toBe(true) // the old pty is still released with its session
  })

  it('holds the restart notice until the replacement session exists, then joins the co-viewer to it', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)

    fake.sent.length = 0
    await recycle(ALICE)
    // Nothing yet: notifying Bob here would let his re-create spawn `nt-node-1` in his stale cwd.
    expect(recycled(sessionId)).toEqual([])

    const fresh = await create(ALICE) // Alice respawns the node in the worktree cwd
    expect(spawned).toHaveLength(2)
    expect(fresh.sessionId).not.toBe(sessionId)
    expect(recycled(sessionId).map((s) => s.to)).toEqual([BOB]) // only now is Bob told
    // `ready` is what makes Bob's restart safe: there IS a session to co-attach to.
    expect(recycled(sessionId)[0].args[0]).toEqual({ ready: true })

    const bob = await create(BOB) // Bob's terminal restarts…
    expect(bob.sessionId).toBe(fresh.sessionId) // …onto the LIVE new session
    expect(bob.fresh).toBe(false) // a co-attach, not a resurrection
    expect(spawned).toHaveLength(2) // and nothing extra was spawned
  })

  it('never sends the restart notice to the client that recycled', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)
    await recycle(ALICE)
    await create(ALICE)
    expect(recycled(sessionId).map((s) => s.to)).not.toContain(ALICE)
  })

  it('a co-viewer is never left on a dead pty: the notice fires even if nobody respawns', async () => {
    await manager()
    const { sessionId } = await create(ALICE)
    await create(BOB)

    fake.sent.length = 0
    await recycle(ALICE)
    expect(recycled(sessionId)).toEqual([])
    // Alice's app quit / crashed mid-move: no replacement session is ever registered. Bob still
    // has to be released from the dead session, so the notice fires on a timeout.
    vi.advanceTimersByTime(15_000)
    expect(recycled(sessionId).map((s) => s.to)).toEqual([BOB])
    // …but it says there is NOTHING to restart onto. Bob must not spawn `nt-node-1` himself: his
    // options still carry the node's OLD cwd, so his session would silently undo the move (and
    // Alice's app, on its return, would `new-session -A` straight back into that stale-cwd
    // session). He shows "session ended — reopen to restart" instead.
    expect(recycled(sessionId)[0].args[0]).toEqual({ ready: false })
  })

  it('a recycle with no other subscriber notifies nobody (the solo path is untouched)', async () => {
    await manager()
    await create(ALICE)
    fake.sent.length = 0
    await recycle(ALICE)
    await create(ALICE)
    vi.advanceTimersByTime(15_000)
    expect(fake.sent.filter((s) => s.channel.startsWith('pty:recycled:'))).toEqual([])
    expect(fake.sent.filter((s) => s.channel.startsWith('pty:closed:'))).toEqual([])
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
