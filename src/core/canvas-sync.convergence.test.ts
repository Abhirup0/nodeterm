// Convergence: two clients, interleaved local edits, one stateless reflector → identical node sets.
//
// No CRDT: node-level last-write-wins is the whole contract. This is the property that makes
// persistence safe — whichever client calls workspace.save writes the same bytes, so a peer's
// delete can never be written back to disk by someone whose canvas still held the node.
//
// Everything here runs against the REAL pieces: the real reflector (initCanvasSync), the real
// publisher (createCanvasPublisher, diff + adopt loop guard + ephemeral filter) and the real
// apply vocabulary (applyCanvasMutation). Only the transport is simulated — a Bus that routes
// `sendTo(id, …)` into the addressed client, exactly as CorePlatform does on both shells.

import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { initPlatform, resetPlatformForTests, type CorePlatform } from './platform'
import { initCanvasSync } from './canvas-sync'
import { applyCanvasMutation } from '../shared/canvas-mutations'
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

const PROJECT = 'p1'

/** The transport: routes sendTo(id, …) into the addressed client's deliver hook, and counts every
 *  cast that reaches the reflector — the number that would grow without bound in an echo loop. */
class Bus {
  deliver = new Map<number, (projectId: string, m: CanvasMutation) => void>()
  private senderListeners = new Map<string, (senderId: number, ...args: any[]) => void>()
  clients: number[] = []
  /** Total casts made BY clients (publisher → reflector). One per real local edit; never more. */
  casts = 0

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
      this.deliver.get(to)?.(args[0] as string, args[1] as CanvasMutation)
    },
    broadcast: () => {},
    openExternal: async () => {}
  }

  cast(senderId: number, projectId: string, m: CanvasMutation): void {
    this.casts++
    this.senderListeners.get(IPC.canvasMut)?.(senderId, projectId, m)
  }
}

/** A simulated client: its own node list, its own publisher, wired to the reflector by ClientId.
 *  Mirrors the two Canvas effects — publish the diff of the settled snapshot, and adopt (never
 *  re-publish) whatever arrives from a peer. */
class Client {
  states: CanvasNodeState[] = []
  /** Ephemeral cards (subagent / loop) this client renders — derived locally, never published. */
  ephemeral = new Set<string>()
  /** Mutations received FROM peers (echo suppression means: never one of our own). */
  received = 0
  private readonly pub = createCanvasPublisher((m) => this.bus.cast(this.id, PROJECT, m))

  constructor(
    readonly id: number,
    private readonly bus: Bus
  ) {
    bus.deliver.set(id, (projectId, m) => {
      if (projectId !== PROJECT) return
      this.received++
      this.states = applyCanvasMutation(this.states, m)
      this.pub.adopt(this.publishable()) // loop guard — never re-publish a peer's change
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
}

let bus: Bus
let a: Client
let b: Client

beforeEach(() => {
  bus = new Bus()
  initPlatform(bus.platform)
  initCanvasSync()
  a = new Client(1, bus)
  b = new Client(2, bus)
  bus.clients = [1, 2]
})
afterEach(() => resetPlatformForTests())

describe('canvas convergence', () => {
  it('interleaved mutations from two clients leave identical node sets', () => {
    a.edit([node('n1', 0)]) // A adds n1
    b.edit([...b.states, node('n2', 0)]) // B adds n2
    a.edit(a.states.map((n) => (n.id === 'n1' ? node('n1', 40) : n))) // A drags n1
    b.edit(b.states.map((n) => (n.id === 'n2' ? node('n2', 0, 'B') : n))) // B renames n2
    a.edit(a.states.filter((n) => n.id !== 'n2')) // A deletes B's node

    expect(a.ids()).toEqual(b.ids())
    expect(a.ids()).toEqual(['n1'])
    expect(a.states).toEqual(b.states)
    expect(a.states.find((n) => n.id === 'n1')!.position.x).toBe(40)
    // The whole point: whichever client saves, it writes the same bytes.
    expect(a.persisted()).toEqual(b.persisted())
  })

  it('converges under EVERY interleaving of the same edit set', () => {
    // Six independent edits, replayed in a batch of different orders. The reflector is stateless
    // and the apply is deterministic, so every order must land on one node set — the only variable
    // is WHICH value survives on a node both clients touched (last write wins, checked below).
    const orders = [
      [0, 1, 2, 3, 4, 5],
      [5, 4, 3, 2, 1, 0],
      [0, 3, 1, 4, 2, 5],
      [2, 0, 5, 1, 3, 4],
      [4, 2, 0, 3, 5, 1]
    ]
    for (const order of orders) {
      bus = new Bus()
      initPlatform(bus.platform)
      initCanvasSync()
      a = new Client(1, bus)
      b = new Client(2, bus)
      bus.clients = [1, 2]

      const edits: Array<() => void> = [
        () => a.edit([...a.states.filter((n) => n.id !== 'n1'), node('n1', 10)]),
        () => b.edit([...b.states.filter((n) => n.id !== 'n2'), node('n2', 20)]),
        () => a.edit(a.states.map((n) => (n.id === 'n2' ? node('n2', 99) : n))),
        () => b.edit(b.states.map((n) => (n.id === 'n1' ? node('n1', 10, 'renamed') : n))),
        () => a.edit([...a.states.filter((n) => n.id !== 'n3'), node('n3', 30)]),
        () => b.edit(b.states.filter((n) => n.id !== 'n3'))
      ]
      for (const i of order) edits[i]()

      expect(a.states, `order ${order.join('')}`).toEqual(b.states)
      expect(a.ids(), `order ${order.join('')}`).toEqual(b.ids())
      expect(a.persisted(), `order ${order.join('')}`).toEqual(b.persisted())
      resetPlatformForTests()
    }
  })

  it('last write wins on a concurrent edit to the same node (no CRDT, no merge, no duplicate)', () => {
    a.edit([node('n1', 0)])
    a.edit([node('n1', 10)])
    b.edit(b.states.map((n) => (n.id === 'n1' ? node('n1', 20) : n)))

    expect(a.states).toEqual(b.states)
    expect(a.states).toHaveLength(1) // one node, not two — upsert replaces by id
    expect(a.states[0].position.x).toBe(20) // B wrote last
  })

  it('no infinite loop: a peer mutation is applied once and re-published NEVER', () => {
    a.edit([node('n1', 0)])
    expect(b.received).toBe(1)
    expect(a.received).toBe(0) // echo suppression: A never gets its own mutation back
    expect(bus.casts).toBe(1) // one local edit → exactly one cast; B did not re-emit it

    b.edit(b.states.map((n) => (n.id === 'n1' ? node('n1', 5) : n)))
    expect(a.received).toBe(1)
    expect(b.received).toBe(1) // B's own edit did not come back, and A did not re-emit it
    expect(bus.casts).toBe(2) // still one cast per local edit — the adopt() guard holds
    expect(a.states).toEqual(b.states)
  })

  it('a burst of peer mutations still produces no counter-cast (3 clients, bulk delete)', () => {
    const c = new Client(3, bus)
    bus.clients = [1, 2, 3]
    a.edit([node('n1', 0), node('n2', 0), node('n3', 0)])
    expect(bus.casts).toBe(3) // three upserts, from A only
    a.edit([]) // bulk delete — three removes in one tick
    expect(bus.casts).toBe(6) // three removes, from A only: B and C reflected nothing back
    expect(b.states).toEqual([])
    expect(c.states).toEqual([])
    expect(a.received + b.received + c.received).toBe(12) // 6 mutations × 2 peers each
  })

  it('ephemeral subagent / loop cards are never published', () => {
    a.ephemeral.add('subagent-abc')
    a.edit([node('n1', 0), node('subagent-abc', 5), node('loop-n1', 9)])

    expect(a.ids()).toEqual(['loop-n1', 'n1', 'subagent-abc']) // A still renders its own cards
    expect(b.ids()).toEqual(['n1']) // …and the peer got only the real node
    expect(b.received).toBe(1)

    // Moving an ephemeral card emits nothing at all (it is not in the published baseline).
    const casts = bus.casts
    a.edit(a.states.map((n) => (n.id === 'subagent-abc' ? node('subagent-abc', 77) : n)))
    expect(bus.casts).toBe(casts)
    expect(b.ids()).toEqual(['n1'])
    // …and the real nodes still converge.
    expect(a.persisted()).toEqual(b.persisted())
  })

  it('a third client that joins late converges with the other two', () => {
    a.edit([node('n1', 0)])
    a.edit([...a.states, node('n2', 0)])
    a.edit(a.states.filter((n) => n.id !== 'n1')) // n1 deleted before C ever connects

    const c = new Client(3, bus)
    bus.clients = [1, 2, 3]
    c.states = [...a.states] // a fresh client loads the canvas from disk/store on mount
    c.pubAdopt() // …and adopts it as the baseline, without republishing it
    expect(bus.casts).toBe(3) // the join itself cast nothing

    a.edit(a.states.map((n) => (n.id === 'n2' ? node('n2', 7) : n)))
    b.edit([...b.states, node('n4', 1)])
    c.edit(c.states.map((n) => (n.id === 'n2' ? node('n2', 7, 'from C') : n)))

    expect(c.states).toEqual(a.states)
    expect(b.states).toEqual(a.states)
    expect(a.ids()).toEqual(['n2', 'n4'])
    expect(a.persisted()).toEqual(c.persisted())
  })

  it('a peer delete is not resurrected by the surviving client (the save-safety property)', () => {
    a.edit([node('n1', 0), node('n2', 0)])
    b.edit(b.states.filter((n) => n.id !== 'n1')) // B deletes n1

    // A's canvas — the one that would be written by ITS next whole-file workspace.save — no longer
    // carries n1. Before Stage 3, A's save would have written the deleted node straight back.
    expect(a.persisted().map((n) => n.id)).toEqual(['n2'])
    expect(a.persisted()).toEqual(b.persisted())

    // And A's subsequent edit does not reintroduce it either.
    a.edit(a.states.map((n) => (n.id === 'n2' ? node('n2', 3) : n)))
    expect(b.ids()).toEqual(['n2'])
  })
})
