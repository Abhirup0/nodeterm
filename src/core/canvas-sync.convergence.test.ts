// Convergence: two clients, interleaved local edits, one ordering reflector → identical node sets.
//
// No CRDT: per-node last-write-wins IN THE REFLECTOR'S TOTAL ORDER is the whole contract. That
// property is what makes persistence safe — whichever client calls workspace.save writes the same
// bytes, so a peer's delete can never be written back to disk by someone whose canvas still held
// the node, and two people dragging one node cannot leave it at two different places forever.
//
// THE BUS IS ASYNCHRONOUS, deliberately. The first version of this suite delivered each mutation
// into the peer inside the sender's own cast() call, so two edits could never be in flight at once
// — which is the ONLY condition under which last-write-wins can diverge. It therefore "passed" a
// design that diverged permanently on the very first concurrent drag. A synchronous bus cannot
// catch this class of bug. Here, casts and deliveries are QUEUED (FIFO per link, exactly as IPC and
// a WebSocket deliver), so a test can hold several edits in flight and choose the interleaving.
//
// Everything else runs against the REAL pieces: the real reflector (initCanvasSync — `seq` stamping
// + fan-out to every client, sender included), the real publisher (createCanvasPublisher: diff,
// `src` stamping, adopt loop guard, ephemeral filter), the real ordering state (createCanvasOrder)
// and the real apply vocabulary (applyCanvasMutation). Only the transport is simulated.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initPlatform, resetPlatformForTests, type CorePlatform } from './platform'
import { initCanvasSync, MUTATION_MAX_BYTES } from './canvas-sync'
import { applyCanvasMutation, isCanvasMutation } from '../shared/canvas-mutations'
import { createCanvasOrder, createReconnectWatch, PENDING_TTL_MS } from '../shared/canvas-order'
import { createCanvasPublisher, publishableStates } from '../shared/canvas-publish'
import { IPC } from '../shared/ipc'
import type { CanvasMutation, CanvasNodeState } from '../shared/types'

const node = (id: string, x: number, title = 't', color = '#fff'): CanvasNodeState =>
  ({
    id,
    kind: 'terminal',
    title,
    color,
    group: null,
    position: { x, y: 0 },
    size: { width: 10, height: 10 }
  }) as CanvasNodeState

/** A sticky whose body someone pasted a document into: its serialized form is over
 *  MUTATION_MAX_BYTES, so the reflector REFUSES it at ingest — silently, with no negative ack. */
const fat = (id: string): CanvasNodeState =>
  ({
    ...node(id, 0),
    kind: 'sticky',
    data: { text: 'x'.repeat(MUTATION_MAX_BYTES) }
  }) as CanvasNodeState

const PROJECT = 'p1'

/**
 * The transport, ASYNC. Two FIFO queues — the two orderings a real deployment guarantees:
 *   - `casts`: client → reflector. The order the reflector pops them in IS the total order.
 *   - `inbox[clientId]`: reflector → that client. Per-connection FIFO (IPC and WS both give this,
 *     and canvas-order's rule 2 depends on it).
 * Nothing moves until the test says so, so several clients can hold edits in flight at once.
 */
class Bus {
  private readonly senderListeners = new Map<string, (senderId: number, ...args: any[]) => void>()
  private readonly casts: Array<{ sender: number; projectId: string; m: CanvasMutation }> = []
  private readonly inbox = new Map<number, Array<{ projectId: string; m: CanvasMutation }>>()
  readonly deliver = new Map<number, (projectId: string, m: CanvasMutation) => void>()
  clients: number[] = []
  /** Total casts made BY clients (publisher → reflector). One per real local edit; never more. */
  castCount = 0
  /** Clients whose INBOX is stalled — their socket is backed up (Stage 2 tolerates an 8 MB pty
   *  backlog on the very same socket), so their acks and their peers' mutations arrive late.
   *  Their casts still reach the reflector: only the return path is blocked. */
  private readonly stalled = new Set<number>()

  platform: CorePlatform = {
    userDataDir: '/tmp/nodeterm-convergence',
    appVersion: '0.0.0-test',
    isPackaged: false,
    handle: () => {},
    on: () => {},
    handleWithSender: () => {},
    onWithSender: (ch, fn) => void this.senderListeners.set(ch, fn),
    clientIds: () => this.clients,
    sendTo: (to, channel, ...args) => {
      if (channel !== IPC.canvasMut) return
      const q = this.inbox.get(to) ?? []
      q.push({ projectId: args[0] as string, m: args[1] as CanvasMutation })
      this.inbox.set(to, q)
    },
    broadcast: () => {},
    openExternal: async () => {}
  }

  /** A client casts: the mutation is QUEUED, not reflected. It reaches the reflector on settle(). */
  cast(senderId: number, projectId: string, m: CanvasMutation): void {
    this.castCount++
    this.casts.push({ sender: senderId, projectId, m })
  }

  /** Pop one cast into the reflector — this is where a mutation gets its place in the total order. */
  private stepCast(): boolean {
    const c = this.casts.shift()
    if (!c) return false
    this.senderListeners.get(IPC.canvasMut)?.(c.sender, c.projectId, c.m)
    return true
  }

  /** Stall / unstall one client's inbox (a backed-up socket). */
  stall(id: number): void {
    this.stalled.add(id)
  }

  unstall(id: number): void {
    this.stalled.delete(id)
  }

  /** Pop one queued delivery into its addressed client (FIFO within that client's inbox). */
  private stepDelivery(): boolean {
    for (const id of this.clients) {
      if (this.stalled.has(id)) continue
      const q = this.inbox.get(id)
      if (!q?.length) continue
      const d = q.shift() as { projectId: string; m: CanvasMutation }
      this.deliver.get(id)?.(d.projectId, d.m)
      return true
    }
    return false
  }

  /** Run the network to quiescence: every queued cast reflected, every delivery delivered. */
  settle(): void {
    for (let i = 0; i < 10_000; i++) {
      if (this.stepCast()) continue
      if (this.stepDelivery()) continue
      return
    }
    throw new Error('bus did not settle — mutation loop?')
  }
}

/** A simulated client: its own node list, publisher and ordering state, wired by ClientId.
 *  Mirrors the two Canvas effects — publish the diff of the settled snapshot; on an incoming
 *  mutation ask the ordering state whether to apply it, then adopt (never re-publish) the result. */
class Client {
  states: CanvasNodeState[] = []
  /** Ephemeral cards (subagent / loop) this client renders — derived locally, never published. */
  ephemeral = new Set<string>()
  /** Mutations APPLIED from the wire (an own echo, or one the order supersedes, is not applied). */
  applied = 0
  /** Local mutations the publisher tried to cast and this client refused (oversized / malformed). */
  refused = 0
  private readonly order: ReturnType<typeof createCanvasOrder>
  private readonly pub: ReturnType<typeof createCanvasPublisher>
  /** Mirrors Canvas's presence subscription: reset the order state only on a GENUINE reconnect. */
  private readonly reconnected = createReconnectWatch(null)

  constructor(
    readonly id: number,
    private readonly bus: Bus
  ) {
    // Built here, not as field initializers: a field initializer runs BEFORE the parameter
    // properties are assigned, so `this.id` would still be undefined and both clients would stamp
    // the same `src` — every peer mutation would then look like their own echo.
    const src = `src-${id}`
    // A FAKE clock: the pending TTL is the one time-dependent rule in canvas-order, and the tests
    // below need to cross it deliberately (`clock += ...`) rather than by sleeping.
    this.order = createCanvasOrder(src, { now: () => clock })
    this.pub = createCanvasPublisher(
      (m) => {
        // Mirrors Canvas: ask the SAME predicate the reflector's ingest asks, BEFORE recording a
        // pending entry or casting. A refusal means nothing was cast — so nothing is pending (the
        // node stays open to its peers) and the publisher keeps the node in its baseline and
        // retries it on the next publish. Canvas also surfaces the refusal to the user.
        if (!isCanvasMutation(m)) {
          this.refused++
          return false
        }
        this.order.onLocal(m)
        bus.cast(id, PROJECT, m)
        return true
      },
      { src }
    )
    bus.deliver.set(id, (projectId, m) => {
      if (projectId !== PROJECT) return
      if (!this.order.accept(m)) return
      this.applied++
      this.states = applyCanvasMutation(this.states, m)
      this.pub.adopt(this.publishable()) // loop guard — never re-publish someone else's change
    })
  }

  private publishable(): CanvasNodeState[] {
    return publishableStates(this.states, this.ephemeral)
  }

  /** A local edit: take the new node list, then publish the diff (what the Canvas effect does). */
  edit(next: CanvasNodeState[]): void {
    this.states = next
    this.pub.publish(this.publishable())
  }

  /** Our presence clientId resolved (or changed). What Canvas's presence subscription does: the
   *  ordering state is forgotten ONLY when a NEW clientId replaces an OLD one — a fresh connection
   *  to a core whose `seq` may have restarted at 0. The first `null → myId` hello is not that. */
  presence(id: string | null): void {
    if (this.reconnected(id)) this.order.reset()
  }

  /** Adopt the freshly loaded canvas as the publisher baseline without publishing it — what Canvas
   *  does while `loadingRef` is set (a project load is not an edit). */
  pubAdopt(): void {
    this.pub.adopt(this.publishable())
  }

  /** The node set that would be written by this client's workspace.save (ephemeral cards excluded,
   *  as flowToNodeStates already excludes them). */
  persisted(): CanvasNodeState[] {
    return this.publishable()
  }

  ids(): string[] {
    return this.states.map((n) => n.id).sort()
  }

  x(id: string): number | undefined {
    return this.states.find((n) => n.id === id)?.position.x
  }
}

/**
 * The convergence contract, canonically: the same NODE SET, and the same VALUE for every node.
 *
 * Array ORDER is deliberately NOT part of it. When a delete loses the order race, the client that
 * issued it removed the node and then re-appended it (applyCanvasMutation appends an upsert of an
 * absent node), so its array can end up carrying that node in a different SLOT than a client that
 * never removed it. Array order drives only the sidebar listing — positions, sizes, data and the
 * node set all agree, so either client's save writes a canvas the other agrees with. Documented as
 * such in docs/team-presence.md; use this helper wherever a resurrection can happen.
 */
const canon = (c: Client): CanvasNodeState[] =>
  [...c.persisted()].sort((x, y) => x.id.localeCompare(y.id))

let bus: Bus
let a: Client
let b: Client
/** The clients' shared fake clock (ms), read by every canvas-order pending TTL. */
let clock = 0

function boot(): void {
  clock = 1_000
  bus = new Bus()
  initPlatform(bus.platform)
  initCanvasSync()
  a = new Client(1, bus)
  b = new Client(2, bus)
  bus.clients = [1, 2]
}

beforeEach(boot)
afterEach(() => resetPlatformForTests())

describe('canvas convergence (async bus)', () => {
  // THE case a synchronous bus cannot express: both clients edit the SAME node before either has
  // heard from the other. Two people dragging one node cross like this on every single frame.
  it('concurrent move of the same node converges (both land on the ordered winner)', () => {
    a.edit([node('n1', 0)])
    bus.settle()

    // In flight at the same time: A drags n1 to 200, B drags the same node to 100.
    a.edit([node('n1', 200)])
    b.edit([node('n1', 100)])
    bus.settle()

    expect(a.states).toEqual(b.states)
    expect(a.x('n1')).toBe(b.x('n1'))
    // The reflector popped A's cast first, so B's is the LATER write in the total order — B wins,
    // on both canvases. (Before the ordering fix: A showed 200 and B showed 100, forever.)
    expect(a.x('n1')).toBe(100)
    expect(a.persisted()).toEqual(b.persisted())
  })

  it('converges whichever way the reflector orders the two concurrent writes', () => {
    b.edit([node('n1', 100)]) // B's cast is queued first this time
    a.edit([node('n1', 200)])
    bus.settle()
    expect(a.states).toEqual(b.states)
    expect(a.x('n1')).toBe(200) // A's cast was popped last → A wins, on both
  })

  // The bug Stage 3 exists to kill, in its sharpest form: A deletes a node while B is dragging it.
  // Divergence here is not cosmetic — A's next whole-file workspace.save would write the node
  // straight back over B's canvas (or vice versa).
  it('concurrent delete vs move of the same node converges (no split-brain save)', () => {
    a.edit([node('n1', 0), node('n2', 0)])
    bus.settle()

    a.edit(a.states.filter((n) => n.id !== 'n1')) // A deletes n1…
    b.edit(b.states.map((n) => (n.id === 'n1' ? node('n1', 50) : n))) // …while B drags it
    bus.settle()

    // Whatever the total order decided, BOTH clients agree — that is the save-safety property.
    // Here A's remove was ordered first, so B's later drag frame wins and the node survives on both
    // (an honest last-write-wins outcome; see docs/team-presence.md). What can no longer happen is
    // A holding the node while B does not — the split-brain that made A's save resurrect it on disk.
    expect(a.ids()).toEqual(b.ids())
    expect(a.ids()).toEqual(['n1', 'n2'])
    expect(canon(a)).toEqual(canon(b)) // same node set, same values (A re-appended n1: see `canon`)
    expect(a.x('n1')).toBe(50) // B's drag frame is the last write
  })

  it('delete wins when it is the later write, and stays deleted on both', () => {
    a.edit([node('n1', 0), node('n2', 0)])
    bus.settle()

    b.edit(b.states.map((n) => (n.id === 'n1' ? node('n1', 50) : n))) // B's move is cast first…
    a.edit(a.states.filter((n) => n.id !== 'n1')) // …A's delete is ordered after it
    bus.settle()

    expect(a.ids()).toEqual(['n2'])
    expect(b.ids()).toEqual(['n2'])
    expect(a.persisted()).toEqual(b.persisted())
  })

  // A drag is a STREAM of concurrent writes: 20 Hz of frames from each side, all in flight at once.
  it('two clients dragging the same node for many frames still converge', () => {
    a.edit([node('n1', 0)])
    bus.settle()
    for (let i = 1; i <= 20; i++) {
      a.edit([node('n1', i * 10)])
      b.edit([node('n1', 1000 - i * 10)])
      if (i % 3 === 0) bus.settle() // …with the network catching up only sometimes
    }
    bus.settle()

    expect(a.states).toEqual(b.states)
    expect(a.persisted()).toEqual(b.persisted())
  })

  it('interleaved mutations from two clients leave identical node sets', () => {
    a.edit([node('n1', 0)]) // A adds n1
    bus.settle()
    b.edit([...b.states, node('n2', 0)]) // B adds n2
    bus.settle()
    a.edit(a.states.map((n) => (n.id === 'n1' ? node('n1', 40) : n))) // A drags n1
    b.edit(b.states.map((n) => (n.id === 'n2' ? node('n2', 0, 'B') : n))) // B renames n2
    bus.settle()
    a.edit(a.states.filter((n) => n.id !== 'n2')) // A deletes B's node
    bus.settle()

    expect(a.ids()).toEqual(b.ids())
    expect(a.ids()).toEqual(['n1'])
    expect(a.states).toEqual(b.states)
    expect(a.x('n1')).toBe(40)
    // The whole point: whichever client saves, it writes the same bytes.
    expect(a.persisted()).toEqual(b.persisted())
  })

  it('converges under every interleaving AND every settle point of the same edit set', () => {
    // Six edits, replayed in different orders AND with the network settling at different points —
    // `settleEvery: 6` means all six are cast before a single one is delivered, i.e. maximum
    // concurrency. Both clients must land on one node set every time.
    const orders = [
      [0, 1, 2, 3, 4, 5],
      [5, 4, 3, 2, 1, 0],
      [0, 3, 1, 4, 2, 5],
      [2, 0, 5, 1, 3, 4],
      [4, 2, 0, 3, 5, 1]
    ]
    for (const order of orders) {
      for (const settleEvery of [1, 2, 6]) {
        resetPlatformForTests()
        boot()

        const edits: Array<() => void> = [
          () => a.edit([...a.states.filter((n) => n.id !== 'n1'), node('n1', 10)]),
          () => b.edit([...b.states.filter((n) => n.id !== 'n2'), node('n2', 20)]),
          () => a.edit(a.states.map((n) => (n.id === 'n2' ? node('n2', 99) : n))),
          () => b.edit(b.states.map((n) => (n.id === 'n1' ? node('n1', 10, 'renamed') : n))),
          () => a.edit([...a.states.filter((n) => n.id !== 'n3'), node('n3', 30)]),
          () => b.edit(b.states.filter((n) => n.id !== 'n3'))
        ]
        let n = 0
        for (const i of order) {
          edits[i]()
          if (++n % settleEvery === 0) bus.settle()
        }
        bus.settle()

        const tag = `order ${order.join('')} settle/${settleEvery}`
        // `canon`, not raw array equality: this set contains a delete that can lose the order race,
        // and the client that issued it re-appends the node in a different slot (see `canon`).
        expect(a.ids(), tag).toEqual(b.ids())
        expect(canon(a), tag).toEqual(canon(b))
      }
    }
  })

  it('three clients editing the same node concurrently converge on one value', () => {
    const c = new Client(3, bus)
    bus.clients = [1, 2, 3]
    a.edit([node('n1', 0)])
    bus.settle()

    a.edit([node('n1', 1)])
    b.edit([node('n1', 2)])
    c.edit([node('n1', 3)])
    bus.settle()

    expect(a.states).toEqual(b.states)
    expect(b.states).toEqual(c.states)
    expect(a.x('n1')).toBe(3) // C's cast was ordered last
  })

  it('last write wins on a concurrent edit to the same node (no CRDT, no merge, no duplicate)', () => {
    a.edit([node('n1', 0)])
    a.edit([node('n1', 10)])
    b.edit(b.states.map((n) => (n.id === 'n1' ? node('n1', 20) : n)))
    bus.settle()

    expect(a.states).toEqual(b.states)
    expect(a.states).toHaveLength(1) // one node, not two — upsert replaces by id
  })

  it('no infinite loop: an applied mutation is never re-published', () => {
    a.edit([node('n1', 0)])
    bus.settle()
    expect(b.applied).toBe(1)
    expect(a.applied).toBe(0) // A's own echo is an ACK, not an edit — applied optimistically already
    expect(bus.castCount).toBe(1) // one local edit → exactly one cast; B did not re-emit it

    b.edit(b.states.map((n) => (n.id === 'n1' ? node('n1', 5) : n)))
    bus.settle()
    expect(a.applied).toBe(1)
    expect(b.applied).toBe(1) // B did not apply its own echo, and A did not re-emit it
    expect(bus.castCount).toBe(2) // still one cast per local edit — the adopt() guard holds
    expect(a.states).toEqual(b.states)
  })

  it('a burst of peer mutations still produces no counter-cast (3 clients, bulk delete)', () => {
    const c = new Client(3, bus)
    bus.clients = [1, 2, 3]
    a.edit([node('n1', 0), node('n2', 0), node('n3', 0)])
    bus.settle()
    expect(bus.castCount).toBe(3) // three upserts, from A only
    a.edit([]) // bulk delete — three removes in one tick
    bus.settle()
    expect(bus.castCount).toBe(6) // three removes, from A only: B and C reflected nothing back
    expect(b.states).toEqual([])
    expect(c.states).toEqual([])
    expect(b.applied + c.applied).toBe(12) // 6 mutations × 2 peers each
  })

  it('ephemeral subagent / loop cards are never published', () => {
    a.ephemeral.add('subagent-abc')
    a.edit([node('n1', 0), node('subagent-abc', 5), node('loop-n1', 9)])
    bus.settle()

    expect(a.ids()).toEqual(['loop-n1', 'n1', 'subagent-abc']) // A still renders its own cards
    expect(b.ids()).toEqual(['n1']) // …and the peer got only the real node
    expect(b.applied).toBe(1)

    // Moving an ephemeral card emits nothing at all (it is not in the published baseline).
    const casts = bus.castCount
    a.edit(a.states.map((n) => (n.id === 'subagent-abc' ? node('subagent-abc', 77) : n)))
    bus.settle()
    expect(bus.castCount).toBe(casts)
    expect(b.ids()).toEqual(['n1'])
    // …and the real nodes still converge.
    expect(a.persisted()).toEqual(b.persisted())
  })

  it('a third client that joins late converges with the other two', () => {
    a.edit([node('n1', 0)])
    a.edit([...a.states, node('n2', 0)])
    a.edit(a.states.filter((n) => n.id !== 'n1')) // n1 deleted before C ever connects
    bus.settle()

    const c = new Client(3, bus)
    bus.clients = [1, 2, 3]
    c.states = [...a.states] // a fresh client loads the canvas from disk/store on mount
    c.pubAdopt() // …and adopts it as the baseline, without republishing it
    expect(bus.castCount).toBe(3) // the join itself cast nothing

    a.edit(a.states.map((n) => (n.id === 'n2' ? node('n2', 7) : n)))
    b.edit([...b.states, node('n4', 1)])
    c.edit(c.states.map((n) => (n.id === 'n2' ? node('n2', 7, 'from C') : n)))
    bus.settle()

    expect(c.states).toEqual(a.states)
    expect(b.states).toEqual(a.states)
    expect(a.ids()).toEqual(['n2', 'n4'])
    expect(a.persisted()).toEqual(c.persisted())
  })

  // A LATE ACK. Rule 1 (never re-apply our own echo) is only sound while our optimistic value is
  // still on our canvas. Once rule 2's suppression lapses on the TTL and a peer's OLDER mutation
  // overwrites it, our echo is the only thing that can restore the value that won everywhere else —
  // and rule 1 used to throw it away. Realistic trigger: our socket is backed up with pty output
  // (Stage 2 tolerates an 8 MB backlog on that same socket), so our ack takes longer than the TTL.
  it('a peer edit applied after the TTL is repaired by our own late ack (no permanent split-brain)', () => {
    a.edit([node('n1', 0)])
    bus.settle()

    bus.stall(a.id) // A's socket backs up: nothing reaches A, but its casts still leave.
    b.edit([node('n1', 50)]) // B's edit is cast (and ordered) FIRST…
    a.edit([node('n1', 100)]) // …A's is ordered AFTER it, so A's value wins on every other client.
    bus.settle()
    expect(b.x('n1')).toBe(100) // …and it does: B (and every other client) shows A's 100.

    clock += PENDING_TTL_MS + 1 // A's pending entry expires while its inbox is still stalled.
    bus.unstall(a.id)
    bus.settle() // A now receives B's older mutation, then its OWN echo.

    // A must not be left holding the value that lost the total order — its next whole-file
    // workspace.save would write those losing bytes over everyone else's canvas.
    expect(a.x('n1')).toBe(100)
    expect(a.x('n1')).toBe(b.x('n1'))
    expect(a.persisted()).toEqual(b.persisted())
  })

  // THE FIRST HELLO IS NOT A RECONNECT. Canvas resets the ordering state whenever its presence
  // clientId changes — including the very first `null → myId`, which lands a few ms after mount.
  // A peer's mutation can arrive before that (it is proof of a peer, so we publish), which means one
  // of OUR casts can already be in flight when the reset fires. The reset drops `pending` — so the
  // peer's mutation is no longer suppressed, and our own echo is no longer recognizable as the
  // repair of a value that already won everywhere else. It was dropped, and this client stayed on
  // the LOSING value forever (its whole-file save then wrote those bytes over everyone's canvas):
  // the permanent split-brain the ordering state exists to prevent, reopened by a lifecycle event.
  it('our first presence hello does not lose a cast in flight (the late echo still repairs)', () => {
    a.edit([node('n1', 0)])
    bus.settle()

    b.edit([node('n1', 50)]) // B's edit is cast (and ordered) first…
    a.edit([node('n1', 100)]) // …ours is ordered AFTER it, so 100 wins on every other client.
    a.presence('cl-a') // …and NOW our own presence hello resolves, with that cast still unacked.
    bus.settle()

    expect(b.x('n1')).toBe(100) // B lands on the ordered winner…
    expect(a.x('n1')).toBe(100) // …and so must we (was: 50 — our echo was thrown away).
    expect(a.persisted()).toEqual(b.persisted()) // whoever saves writes the same bytes
  })

  // …but a GENUINE reconnect must still reset. The core restarting puts its `seq` counter back at 0
  // while our `seen` map still holds the old (high) values — every mutation that follows would look
  // like a straggler and be silently dropped, and this client would drift away from its peers with
  // no way back. (Here: a new clientId, and a peer mutation stamped with a LOW seq from the restarted
  // reflector.)
  it('a genuine reconnect forgets the stale seq floor (a restarted core starts at seq 1 again)', () => {
    a.presence('cl-a')
    a.edit([node('n1', 0)])
    b.edit([node('n1', 1)])
    b.edit([node('n1', 2)])
    bus.settle()
    expect(a.x('n1')).toBe(2) // a few mutations in: A's `seen` floor for n1 is now high

    a.presence('cl-a2') // the core restarted → new connection, new clientId, `seq` back at 0
    // The restarted reflector stamps from 1 again. Without the reset this is a straggler and is
    // dropped — A would sit on the old value for the rest of the session.
    bus.deliver.get(a.id)?.(PROJECT, { op: 'upsert', node: node('n1', 9), src: 'src-2', seq: 1 })
    expect(a.x('n1')).toBe(9)
  })

  // A REFUSED CAST. The reflector drops a malformed / oversized mutation at ingest (silently — there
  // is no negative ack). If the publisher has already advanced its baseline it never retries, and if
  // the ordering state has already recorded a pending entry the node goes DEAF to its peers for the
  // whole TTL. A peer's `remove` landing in that window was dropped and never recovered → the next
  // save resurrected the node they deleted. Trigger: a sticky whose body a user pasted a document
  // into (sticky text is unbounded in the UI) is over MUTATION_MAX_BYTES.
  it('an oversized node the reflector refuses does not deafen it to a peer delete', () => {
    a.edit([node('n1', 0), node('n2', 0)])
    bus.settle()

    a.edit([fat('n1'), node('n2', 0)]) // A pastes a document into n1 → the cast is refused at ingest
    b.edit(b.states.filter((n) => n.id !== 'n1')) // …and B deletes n1 in the same window
    bus.settle()

    expect(a.ids()).toEqual(b.ids()) // was: A ['n1','n2'] vs B ['n2'] — forever
    expect(a.ids()).toEqual(['n2'])
    expect(a.persisted()).toEqual(b.persisted())
  })

  it('a refused cast is retried on the next publish (once the node is within the size limit)', () => {
    a.edit([node('n1', 0)])
    bus.settle()

    a.edit([fat('n1')]) // refused: never reaches B
    bus.settle()
    expect(b.x('n1')).toBe(0) // B still shows the last mutation that WAS reflected

    a.edit([node('n1', 7)]) // the user trims the sticky → the edit is within the limit again
    bus.settle()
    expect(b.x('n1')).toBe(7)
    expect(a.persisted()).toEqual(b.persisted())
  })

  it('a refused cast does not block the OTHER nodes in the same snapshot', () => {
    a.edit([node('n1', 0), node('n2', 0)])
    bus.settle()
    a.edit([fat('n1'), node('n2', 42)]) // one refused upsert, one legitimate one
    bus.settle()
    expect(b.x('n2')).toBe(42)
  })

  it('a peer delete is not resurrected by the surviving client (the save-safety property)', () => {
    a.edit([node('n1', 0), node('n2', 0)])
    bus.settle()
    b.edit(b.states.filter((n) => n.id !== 'n1')) // B deletes n1
    bus.settle()

    // A's canvas — the one that would be written by ITS next whole-file workspace.save — no longer
    // carries n1. Before Stage 3, A's save would have written the deleted node straight back.
    expect(a.persisted().map((n) => n.id)).toEqual(['n2'])
    expect(a.persisted()).toEqual(b.persisted())

    // And A's subsequent edit does not reintroduce it either.
    a.edit(a.states.map((n) => (n.id === 'n2' ? node('n2', 3) : n)))
    bus.settle()
    expect(b.ids()).toEqual(['n2'])
  })
})
