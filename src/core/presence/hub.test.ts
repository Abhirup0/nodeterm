import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform, type FakePlatform } from '../platform-fake'
import {
  PresenceHub,
  allocateRelayClientId,
  PRESENCE_RATE_BUDGETS,
  TYPING_THROTTLE_MS
} from './hub'
import { IPC } from '../../shared/ipc'
import { PRESENCE_COLORS, REF_MAX_LEN, type PeerDiff, type PeerState } from '../../shared/presence'

let fake: FakePlatform

beforeEach(() => {
  fake = fakePlatform()
  initPlatform(fake)
})
afterEach(() => {
  resetPlatformForTests()
  vi.useRealTimers()
})

/** Every `presence:peer` diff broadcast so far, in order. */
function diffs(): PeerDiff[] {
  return fake.sent
    .filter((s) => s.to === 'broadcast' && s.channel === IPC.presencePeer)
    .map((s) => s.args[0] as PeerDiff)
}

describe('PresenceHub join/leave', () => {
  it('join creates a peer with a default name + next-free color, snapshots the newcomer, and broadcasts', () => {
    const hub = new PresenceHub()
    hub.join(1, 'browser')
    hub.join(2, 'phone')

    expect(hub.peers()).toEqual([
      {
        clientId: 1,
        name: 'Someone',
        color: PRESENCE_COLORS[0],
        cursor: null,
        focus: null,
        chat: null,
        typing: null,
        projectId: null,
        kind: 'browser'
      },
      {
        clientId: 2,
        name: 'Phone',
        color: PRESENCE_COLORS[1],
        cursor: null,
        focus: null,
        chat: null,
        typing: null,
        projectId: null,
        kind: 'phone'
      }
    ])
    // The newcomer gets the full table (it may never be able to make a request — see the phone).
    const syncs = fake.sent.filter((s) => s.channel === IPC.presenceSync)
    expect(syncs.map((s) => s.to)).toEqual([1, 2])
    expect((syncs[1].args[0] as PeerState[]).map((p) => p.clientId)).toEqual([1, 2])
    expect(diffs()).toEqual([
      { op: 'join', peer: hub.peers()[0] },
      { op: 'join', peer: hub.peers()[1] }
    ])
  })

  it('a phone is a first-class cursorless peer (no fabricated position)', () => {
    const hub = new PresenceHub()
    hub.join(9, 'phone')
    expect(hub.peers()[0].cursor).toBeNull()
    expect(hub.peers()[0].kind).toBe('phone')
  })

  it('join is idempotent, and leave drops the peer + broadcasts', () => {
    const hub = new PresenceHub()
    hub.join(1, 'browser')
    hub.join(1, 'browser')
    expect(hub.peers()).toHaveLength(1)
    hub.leave(1)
    expect(hub.peers()).toEqual([])
    expect(diffs().at(-1)).toEqual({ op: 'leave', clientId: 1 })
    // Leaving twice is a silent no-op (no second diff).
    const before = diffs().length
    hub.leave(1)
    expect(diffs()).toHaveLength(before)
  })

  it('a departing peer frees its color for the next joiner', () => {
    const hub = new PresenceHub()
    hub.join(1, 'browser')
    hub.leave(1)
    hub.join(2, 'browser')
    expect(hub.peers()[0].color).toBe(PRESENCE_COLORS[0])
  })
})

describe('PresenceHub hello', () => {
  it('returns the caller its own id + the full table, and broadcasts the identity update', () => {
    const hub = new PresenceHub()
    hub.join(1, 'browser')
    hub.join(2, 'browser')
    const res = hub.hello(2, { name: '  Enes ', color: PRESENCE_COLORS[3] })
    expect(res.clientId).toBe(2)
    expect(res.peers.map((p) => p.clientId)).toEqual([1, 2])
    expect(hub.peers()[1]).toMatchObject({ name: 'Enes', color: PRESENCE_COLORS[3] })
    expect(diffs().at(-1)).toEqual({
      op: 'update',
      clientId: 2,
      patch: { name: 'Enes', color: PRESENCE_COLORS[3] }
    })
  })

  it('sanitizes junk (off-palette color / empty name) and ignores an unknown client', () => {
    const hub = new PresenceHub()
    hub.join(1, 'browser')
    hub.hello(1, { name: '', color: 'url(evil)' } as never)
    expect(hub.peers()[0]).toMatchObject({ name: 'Someone', color: PRESENCE_COLORS[0] })
    // A hello from a client that never joined must not create a ghost peer.
    const res = hub.hello(99, { name: 'Ghost', color: PRESENCE_COLORS[1] })
    expect(res).toEqual({ clientId: 99, peers: hub.peers() })
    expect(hub.peers()).toHaveLength(1)
  })

  // A reconnecting client re-sends its stored identity; that must not fan an identical diff out
  // to every peer. But it must STILL get its own clientId back — that return is how the renderer
  // learns which cursor is its own.
  it('an unchanged identity broadcasts nothing but still returns {clientId, peers}', () => {
    const hub = new PresenceHub()
    hub.join(1, 'browser')
    hub.join(2, 'browser')
    hub.hello(2, { name: 'Enes', color: PRESENCE_COLORS[3] })
    const after = diffs().length

    const res = hub.hello(2, { name: 'Enes', color: PRESENCE_COLORS[3] })
    expect(diffs()).toHaveLength(after) // no change → no diff
    expect(res.clientId).toBe(2)
    expect(res.peers.map((p) => p.clientId)).toEqual([1, 2])

    // A real change still broadcasts.
    hub.hello(2, { name: 'Enes', color: PRESENCE_COLORS[4] })
    expect(diffs().at(-1)).toEqual({
      op: 'update',
      clientId: 2,
      patch: { name: 'Enes', color: PRESENCE_COLORS[4] }
    })
  })
})

describe('PresenceHub signals', () => {
  it('setCursor / setFocus / setChat / setProject patch the peer and broadcast an update diff', () => {
    const hub = new PresenceHub()
    hub.join(1, 'browser')
    // The project comes FIRST, as it does in the app (Canvas reports the canvas it loaded, then
    // the pointer starts moving on it) — a later setProject would drop the cursor with the old
    // canvas it belongs to (see the project-switch test below).
    hub.setProject(1, 'web')
    hub.setCursor(1, { x: 12.4, y: -3 })
    hub.setFocus(1, 'node-a')
    hub.setChat(1, 'hey')
    expect(hub.peers()[0]).toMatchObject({
      cursor: { x: 12.4, y: -3 },
      focus: 'node-a',
      chat: 'hey',
      projectId: 'web'
    })
    expect(diffs().slice(-4)).toEqual([
      { op: 'update', clientId: 1, patch: { projectId: 'web' } },
      { op: 'update', clientId: 1, patch: { cursor: { x: 12.4, y: -3 } } },
      { op: 'update', clientId: 1, patch: { focus: 'node-a' } },
      { op: 'update', clientId: 1, patch: { chat: 'hey' } }
    ])
    hub.setCursor(1, null)
    hub.setChat(1, null)
    expect(hub.peers()[0]).toMatchObject({ cursor: null, chat: null })
  })

  it('setProject: switching canvases re-broadcasts, the same project is a silent no-op, and a peer with no project open goes back to null', () => {
    const hub = new PresenceHub()
    hub.join(1, 'browser')
    hub.setProject(1, 'web')
    const after = diffs().length
    hub.setProject(1, 'web') // no change → no diff (a tab switch back must not spam the wire)
    expect(diffs()).toHaveLength(after)
    hub.setProject(1, 'api')
    expect(diffs().at(-1)).toEqual({ op: 'update', clientId: 1, patch: { projectId: 'api' } })
    hub.setProject(1, null) // closed the last project → welcome screen
    expect(hub.peers()[0].projectId).toBeNull()
    // Unknown client: silent no-op, no ghost peer.
    hub.setProject(42, 'web')
    expect(hub.peers()).toHaveLength(1)
  })

  // A project switch can be keyboard-driven (⌘1/⌘2, the palette) with the mouse parked, so no
  // pointermove follows it and the renderer's sampler never sends a new position. Leaving the old
  // cursor in the table would draw this peer on the NEW canvas at the OLD canvas's flow
  // coordinates — a ghost pointing at nothing, indefinitely, for everyone on that project.
  it('setProject drops the cursor with the old canvas (one coherent diff carries both)', () => {
    const hub = new PresenceHub()
    hub.join(1, 'browser')
    hub.setProject(1, 'web')
    hub.setCursor(1, { x: 400, y: 250 })

    hub.setProject(1, 'api')
    expect(hub.peers()[0]).toMatchObject({ projectId: 'api', cursor: null })
    // ONE diff, carrying both changes: a peer applying it can never see the new project with the
    // stale cursor, in either order.
    expect(diffs().at(-1)).toEqual({
      op: 'update',
      clientId: 1,
      patch: { projectId: 'api', cursor: null }
    })

    // Nothing to drop → the patch stays minimal (no redundant cursor: null on every switch).
    hub.setProject(1, 'web')
    expect(diffs().at(-1)).toEqual({ op: 'update', clientId: 1, patch: { projectId: 'web' } })
  })

  it('drops garbage input instead of broadcasting it (NaN cursor, over-long chat, unknown client)', () => {
    const hub = new PresenceHub()
    hub.join(1, 'browser')
    const before = diffs().length
    hub.setCursor(1, { x: Number.NaN, y: 0 })
    hub.setCursor(2, { x: 1, y: 1 }) // never joined
    hub.setFocus(2, 'node-a')
    expect(diffs()).toHaveLength(before)
    hub.setChat(1, 'y'.repeat(500))
    expect(hub.peers()[0].chat).toHaveLength(200)
  })

  it('caps chat at CHAT_MAX_LEN *code points*, so an emoji is never cut into a lone surrogate', () => {
    const hub = new PresenceHub()
    hub.join(1, 'browser')
    // 300 astral code points (600 UTF-16 units): a naive slice() would cut one in half.
    hub.setChat(1, '🙂'.repeat(300))
    const chat = hub.peers()[0].chat as string
    expect([...chat]).toHaveLength(200)
    expect(chat).toBe('🙂'.repeat(200))
    // The cap is enforced at ingest, so the broadcast diff carries the capped text too.
    expect(diffs().at(-1)).toEqual({ op: 'update', clientId: 1, patch: { chat } })
  })

  // The cursor is recomputed (and re-sent) on every pan/zoom frame, and mouse-leave/blur both
  // send null. An unchanged value must not fan out to every peer for zero visual change.
  it('setCursor: an unchanged position (and a repeated null) is a silent no-op', () => {
    const hub = new PresenceHub()
    hub.join(1, 'browser')
    hub.setCursor(1, { x: 10, y: 20 })
    const after = diffs().length

    hub.setCursor(1, { x: 10, y: 20 }) // same position (pan/zoom recompute) → no diff
    expect(diffs()).toHaveLength(after)

    hub.setCursor(1, { x: 10, y: 21 }) // y moved → broadcast
    expect(diffs()).toHaveLength(after + 1)
    hub.setCursor(1, { x: 11, y: 21 }) // x moved → broadcast
    expect(diffs()).toHaveLength(after + 2)

    hub.setCursor(1, null) // mouse leave → broadcast
    expect(diffs()).toHaveLength(after + 3)
    hub.setCursor(1, null) // blur right after leave → already null → no diff
    expect(diffs()).toHaveLength(after + 3)
    expect(hub.peers()[0].cursor).toBeNull()

    hub.setCursor(1, { x: 11, y: 21 }) // back from null → broadcast
    expect(diffs()).toHaveLength(after + 4)
  })

  // Esc-then-blur closes the bubble twice, and a re-render can re-send identical text.
  it('setChat: unchanged text (and a repeated null) is a silent no-op, compared AFTER the cap', () => {
    const hub = new PresenceHub()
    hub.join(1, 'browser')
    hub.setChat(1, 'hey')
    const after = diffs().length

    hub.setChat(1, 'hey') // identical → no diff
    expect(diffs()).toHaveLength(after)
    hub.setChat(1, 'hey!') // changed → broadcast
    expect(diffs()).toHaveLength(after + 1)

    hub.setChat(1, null) // Esc closes the bubble
    expect(diffs()).toHaveLength(after + 2)
    hub.setChat(1, null) // blur closes it again → already null → no diff
    expect(diffs()).toHaveLength(after + 2)

    // Two DIFFERENT over-long strings that cap to the same 200 code points are the same peer
    // state — comparing the raw text would leak a broadcast per keystroke past the cap.
    hub.setChat(1, 'z'.repeat(500))
    const capped = diffs().length
    hub.setChat(1, 'z'.repeat(600))
    expect(diffs()).toHaveLength(capped)
    expect(hub.peers()[0].chat).toBe('z'.repeat(200))
  })

  it('peers() and the join diff hand out copies, so a caller cannot corrupt hub state', () => {
    const hub = new PresenceHub()
    hub.join(1, 'browser')
    hub.setCursor(1, { x: 1, y: 2 })
    hub.noteTyping(1, 'node-a')

    // Nested objects are copies too — mutating them must not reach the hub's table.
    const snap = hub.peers()[0]
    snap.name = 'hacked'
    ;(snap.cursor as { x: number; y: number }).x = 999
    ;(snap.typing as { nodeId: string }).nodeId = 'node-evil'
    expect(hub.peers()[0]).toMatchObject({
      name: 'Someone',
      cursor: { x: 1, y: 2 },
      typing: { nodeId: 'node-a' }
    })

    // The join diff carries a copy, not the live PeerState reference.
    hub.join(2, 'browser')
    const joined = diffs().at(-1) as { op: 'join'; peer: PeerState }
    expect(joined.op).toBe('join')
    hub.setFocus(2, 'node-z')
    expect(joined.peer.focus).toBeNull() // a live reference would have followed the setter
  })
})

describe('PresenceHub noteTyping (Stage 2 caller; wired here)', () => {
  it('throttles to one broadcast per node per 500ms and re-fires for a different node', () => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
    const hub = new PresenceHub()
    hub.join(1, 'browser')
    const before = diffs().length

    hub.noteTyping(1, 'node-a')
    hub.noteTyping(1, 'node-a') // inside the throttle window → swallowed
    expect(diffs()).toHaveLength(before + 1)
    expect(hub.peers()[0].typing).toEqual({ nodeId: 'node-a', at: 1_000_000 })

    // A different node always re-fires (it's a different badge).
    hub.noteTyping(1, 'node-b')
    expect(diffs()).toHaveLength(before + 2)

    vi.setSystemTime(1_000_000 + TYPING_THROTTLE_MS + 1)
    hub.noteTyping(1, 'node-a')
    expect(diffs()).toHaveLength(before + 3)
  })

  // The throttle key is (client, node) ALONE. A throttle that also required the peer's *current*
  // typing badge to be on the same node would be defeated by a client writing alternately into
  // two nodes (split terminal, agent + shell): every call would see a different last node and
  // broadcast, at keystroke rate, to every peer.
  it('throttles per (client, node) even when the client alternates between two nodes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(2_000_000)
    const hub = new PresenceHub()
    hub.join(1, 'browser')
    const before = diffs().length

    // 20 interleaved keystrokes inside one throttle window → one broadcast per node, not 20.
    for (let i = 0; i < 10; i++) {
      hub.noteTyping(1, 'node-a')
      hub.noteTyping(1, 'node-b')
    }
    expect(diffs()).toHaveLength(before + 2)

    // Each node's window is its own: node-a's expires, node-b's has not.
    vi.setSystemTime(2_000_000 + TYPING_THROTTLE_MS + 1)
    hub.noteTyping(1, 'node-a')
    expect(diffs()).toHaveLength(before + 3)
    hub.noteTyping(1, 'node-b')
    expect(diffs()).toHaveLength(before + 4) // node-b's window opened at the same time → also due
  })

  // Two clients typing in the same node must not throttle each other (the key carries the client).
  it('throttles per client, not globally per node', () => {
    vi.useFakeTimers()
    vi.setSystemTime(3_000_000)
    const hub = new PresenceHub()
    hub.join(1, 'browser')
    hub.join(2, 'browser')
    const before = diffs().length
    hub.noteTyping(1, 'node-a')
    hub.noteTyping(2, 'node-a')
    expect(diffs()).toHaveLength(before + 2)
  })
})

describe('caps on client-supplied ids (focus / project)', () => {
  // Focus and project ids come straight off the wire and are stored verbatim in the peer table and
  // reflected to EVERY peer. Uncapped, a 10 MB `presence:focus` becomes 10 MB x N peers of egress
  // down the very sink pty output rides — terminals would stall behind a hostile string.
  it('caps focus and project at REF_MAX_LEN code points, in the table AND in the broadcast diff', () => {
    const hub = new PresenceHub()
    hub.join(1, 'browser')

    hub.setFocus(1, 'n'.repeat(REF_MAX_LEN + 5_000))
    expect(hub.peers()[0].focus).toBe('n'.repeat(REF_MAX_LEN))
    expect(diffs().at(-1)).toEqual({
      op: 'update',
      clientId: 1,
      patch: { focus: 'n'.repeat(REF_MAX_LEN) }
    })

    hub.setProject(1, 'p'.repeat(REF_MAX_LEN + 5_000))
    expect(hub.peers()[0].projectId).toBe('p'.repeat(REF_MAX_LEN))
    expect(diffs().at(-1)).toMatchObject({
      op: 'update',
      clientId: 1,
      patch: { projectId: 'p'.repeat(REF_MAX_LEN) }
    })
  })

  it('caps by code point (the shared truncation rule), never splitting an emoji', () => {
    const hub = new PresenceHub()
    hub.join(1, 'browser')
    hub.setFocus(1, '🙂'.repeat(REF_MAX_LEN + 100))
    const focus = hub.peers()[0].focus as string
    expect([...focus]).toHaveLength(REF_MAX_LEN)
    expect(focus).not.toMatch(/[\uD800-\uDFFF]/u)
  })

  // Real ids are short (`term-ab12`, `web-3f9c`), so the cap can never truncate a legitimate one.
  it('leaves a real node/project id untouched', () => {
    const hub = new PresenceHub()
    hub.join(1, 'browser')
    hub.setFocus(1, 'term-ab12cd')
    hub.setProject(1, 'proj-9f3a-2')
    expect(hub.peers()[0]).toMatchObject({ focus: 'term-ab12cd', projectId: 'proj-9f3a-2' })
  })
})

describe('rate limiting (a hostile tab must not degrade the room)', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(0)
  })

  /** Fire `n` cursor casts through the CAST entry point (where the limiter lives), each with a
   *  distinct position so the unchanged-value no-op can never be mistaken for a rate-limit drop. */
  function floodCursor(clientId: number, n: number, from = 0): void {
    for (let i = 0; i < n; i++) {
      fake.senderListeners[IPC.presenceCursor](clientId, { x: from + i, y: 0 })
    }
  }

  it('drops cursor casts past the burst budget, and refills at the sustained rate', () => {
    const hub = new PresenceHub()
    hub.registerIpc()
    hub.join(1, 'browser')
    const budget = PRESENCE_RATE_BUDGETS[IPC.presenceCursor]

    const before = diffs().length
    floodCursor(1, 1000) // a tight loop, all in the same millisecond
    const passed = diffs().length - before
    expect(passed).toBe(budget.burst) // the bucket, and not one cast more

    // No time passed → still nothing gets through.
    floodCursor(1, 100, 10_000)
    expect(diffs().length - before).toBe(budget.burst)

    // One second later the bucket has refilled by exactly the sustained rate.
    vi.setSystemTime(1000)
    floodCursor(1, 1000, 20_000)
    expect(diffs().length - before).toBe(budget.burst + budget.perSec)
  })

  it('never drops an honest client: the renderer 20 Hz cursor stream passes in full', () => {
    const hub = new PresenceHub()
    hub.registerIpc()
    hub.join(1, 'browser')

    const before = diffs().length
    // 10 s of the renderer's own throttle (CURSOR_MIN_INTERVAL_MS = 50 → 20 Hz). The cursor budget
    // is matched to it, so a well-behaved tab must never lose a sample.
    for (let i = 0; i < 200; i++) {
      vi.setSystemTime(i * 50)
      fake.senderListeners[IPC.presenceCursor](1, { x: i, y: i })
    }
    expect(diffs().length - before).toBe(200)
  })

  it('the limit is per (client, channel): a flooding tab starves neither its peers nor its own other channels', () => {
    const hub = new PresenceHub()
    hub.registerIpc()
    hub.join(1, 'browser')
    hub.join(2, 'browser')

    floodCursor(1, 1000) // client 1 exhausts its cursor bucket
    const after = diffs().length

    // Client 2's cursor is untouched…
    fake.senderListeners[IPC.presenceCursor](2, { x: 1, y: 1 })
    expect(diffs().at(-1)).toEqual({ op: 'update', clientId: 2, patch: { cursor: { x: 1, y: 1 } } })
    // …and so is client 1's focus (a separate channel keeps a separate bucket).
    fake.senderListeners[IPC.presenceFocus](1, 'node-a')
    expect(diffs().at(-1)).toEqual({ op: 'update', clientId: 1, patch: { focus: 'node-a' } })
    expect(diffs().length).toBe(after + 2)
  })

  it('throttles the chat, focus and project channels too', () => {
    const hub = new PresenceHub()
    hub.registerIpc()
    hub.join(1, 'browser')

    for (const [channel, cast] of [
      [IPC.presenceChat, (i: number) => fake.senderListeners[IPC.presenceChat](1, `msg ${i}`)],
      [IPC.presenceFocus, (i: number) => fake.senderListeners[IPC.presenceFocus](1, `node-${i}`)],
      [IPC.presenceProject, (i: number) => fake.senderListeners[IPC.presenceProject](1, `p-${i}`)]
    ] as Array<[string, (i: number) => void]>) {
      const before = diffs().length
      for (let i = 0; i < 500; i++) cast(i)
      expect(diffs().length - before).toBe(PRESENCE_RATE_BUDGETS[channel].burst)
    }
  })

  it('a dropped cast changes nothing — the peer keeps the last state that got through', () => {
    const hub = new PresenceHub()
    hub.registerIpc()
    hub.join(1, 'browser')
    const budget = PRESENCE_RATE_BUDGETS[IPC.presenceCursor]

    floodCursor(1, budget.burst + 50)
    // The dropped casts must not be applied to the table either (silently ignored, not queued).
    expect(hub.peers()[0].cursor).toEqual({ x: budget.burst - 1, y: 0 })
  })

  it('leaving frees the client\'s buckets, so a reconnecting id starts fresh', () => {
    const hub = new PresenceHub()
    hub.registerIpc()
    hub.join(1, 'browser')
    const budget = PRESENCE_RATE_BUDGETS[IPC.presenceCursor]
    floodCursor(1, 1000)

    hub.leave(1)
    hub.join(1, 'browser')
    const before = diffs().length
    floodCursor(1, 1000, 50_000)
    expect(diffs().length - before).toBe(budget.burst)
  })
})

describe('registerIpc', () => {
  it('registers hello as a sender-aware request and the three signals as sender-aware casts', () => {
    const hub = new PresenceHub()
    hub.registerIpc()
    hub.join(4, 'browser')

    const res = fake.handlers[IPC.presenceHello](4, { name: 'Ada', color: PRESENCE_COLORS[2] })
    expect(res).toMatchObject({ clientId: 4 })

    // Project first, cursor after — the app's own order (a cursor only means something once the
    // canvas it was sampled on is known; a later switch drops it).
    fake.senderListeners[IPC.presenceProject](4, 'web')
    fake.senderListeners[IPC.presenceCursor](4, { x: 5, y: 6 })
    fake.senderListeners[IPC.presenceFocus](4, 'node-z')
    fake.senderListeners[IPC.presenceChat](4, 'yo')
    expect(hub.peers()[0]).toMatchObject({
      name: 'Ada',
      cursor: { x: 5, y: 6 },
      focus: 'node-z',
      chat: 'yo',
      projectId: 'web'
    })
  })

  // The shell's listener registry does NOT dedup identical function references, so a second
  // registration would make every cast fire twice. The hub guards against that itself.
  it('is idempotent: a second call registers nothing', () => {
    const registered: string[] = []
    initPlatform(
      fakePlatform({
        handleWithSender: (ch) => registered.push(ch),
        onWithSender: (ch) => registered.push(ch)
      })
    )
    const hub = new PresenceHub()
    hub.registerIpc()
    expect(registered).toEqual([
      IPC.presenceHello,
      IPC.presenceCursor,
      IPC.presenceFocus,
      IPC.presenceChat,
      IPC.presenceProject
    ])
    hub.registerIpc()
    expect(registered).toHaveLength(5)
  })
})

describe('shell adapters (desktop window + relay phone)', () => {
  it('a desktop window and a relay phone coexist as peers with distinct ids and colors', () => {
    const hub = new PresenceHub()
    const windowId = 1 // Electron webContents.id
    const phoneId = allocateRelayClientId()
    hub.join(windowId, 'desktop')
    hub.join(phoneId, 'phone')

    expect(phoneId).not.toBe(windowId)
    const [desk, phone] = hub.peers()
    expect(desk).toMatchObject({ kind: 'desktop', name: 'Someone', cursor: null })
    expect(phone).toMatchObject({ kind: 'phone', name: 'Phone', cursor: null })
    expect(desk.color).not.toBe(phone.color)

    // sendTo for a relay peer targets an id no shell can resolve — it must be a silent drop,
    // never a throw (Electron's webContents.fromId returns null; ServerPlatform has no sink).
    expect(() => hub.setChat(phoneId, 'from the phone')).not.toThrow()

    hub.leave(phoneId)
    expect(hub.peers().map((p) => p.kind)).toEqual(['desktop'])
  })
})

describe('allocateRelayClientId', () => {
  it('mints monotonic ids from a range that cannot collide with a UI id', () => {
    const a = allocateRelayClientId()
    const b = allocateRelayClientId()
    expect(a).toBeGreaterThanOrEqual(1_000_000)
    expect(b).toBe(a + 1)
  })
})
