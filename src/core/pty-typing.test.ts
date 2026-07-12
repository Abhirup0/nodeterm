// TYPING ATTRIBUTION — who wrote into which node's terminal (docs/team-presence.md).
//
// Stage 2 makes a terminal co-attachable, so a keystroke arriving at the pty is no longer
// self-evidently "the one user's". `pty:write` is therefore registered SENDER-AWARE, and the
// sending client is stamped onto the node id (the session's persistKey) via presenceHub.noteTyping
// — that is the whole "X is typing" ring. Attribution is server-side: the transport already knows
// who the sender is (webContents id / uiId / relay HostSession), so no client can claim to be
// someone else, and a phone typing over the relay is attributed with zero client-side change.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform, type FakePlatform } from './platform-fake'
import { presenceHub } from './presence/hub'
import { IPC } from '../shared/ipc'

vi.mock('node-pty', () => ({
  spawn: () => ({
    onData: () => {},
    onExit: () => {},
    write: () => {},
    resize: () => {},
    pause: () => {},
    resume: () => {},
    kill: () => {},
    pid: 1
  })
}))

const ALICE = 7
const BOB = 9

describe('typing attribution', () => {
  let fake: FakePlatform
  beforeEach(() => {
    fake = fakePlatform()
    initPlatform(fake)
  })
  afterEach(() => {
    // Leave the peers we joined: the hub is a process-wide singleton, so a test that left a peer
    // behind would change the next test's peer count (and so its typing behavior).
    presenceHub.leave(ALICE)
    presenceHub.leave(BOB)
    vi.restoreAllMocks()
    resetPlatformForTests()
  })

  const write = (clientId: number, sessionId: string, data: string): void =>
    fake.senderListeners[IPC.ptyWrite](clientId, sessionId, data)

  it('stamps the SENDING client on every pty:write, keyed by the node id (persistKey)', async () => {
    presenceHub.join(ALICE, 'desktop')
    presenceHub.join(BOB, 'browser')
    const noteTyping = vi.spyOn(presenceHub, 'noteTyping')
    const { PtyManager } = await import('./pty-manager')
    new PtyManager().registerIpc()
    const { sessionId } = (await fake.handlers[IPC.ptyCreate](ALICE, {
      cols: 80,
      rows: 24,
      persistKey: 'node-42'
    })) as { sessionId: string }

    write(ALICE, sessionId, 'l')
    write(BOB, sessionId, 's') // a second person typing into the same shell
    expect(noteTyping.mock.calls).toEqual([
      [ALICE, 'node-42'],
      [BOB, 'node-42']
    ])
  })

  it('does not attribute a write to a session with no node id (no persistKey → nothing to badge)', async () => {
    presenceHub.join(ALICE, 'desktop')
    presenceHub.join(BOB, 'browser')
    const noteTyping = vi.spyOn(presenceHub, 'noteTyping')
    const { PtyManager } = await import('./pty-manager')
    new PtyManager().registerIpc()
    const { sessionId } = (await fake.handlers[IPC.ptyCreate](ALICE, { cols: 80, rows: 24 })) as {
      sessionId: string
    }
    write(ALICE, sessionId, 'x')
    expect(noteTyping).not.toHaveBeenCalled()
  })

  // The single-user path pays NOTHING for a feature that exists for a second person: with one peer
  // in the table the only recipient of a typing badge is the typist, whose own badge is never drawn.
  // Calling noteTyping anyway would fan a presence:peer diff out to the renderer twice a second, for
  // every keystroke burst, for the person working alone — which is everybody, most of the time.
  it('does not touch presence at all while the user is ALONE (no peer to badge)', async () => {
    presenceHub.join(ALICE, 'desktop')
    const noteTyping = vi.spyOn(presenceHub, 'noteTyping')
    const { PtyManager } = await import('./pty-manager')
    new PtyManager().registerIpc()
    const { sessionId } = (await fake.handlers[IPC.ptyCreate](ALICE, {
      cols: 80,
      rows: 24,
      persistKey: 'node-42'
    })) as { sessionId: string }

    fake.sent.length = 0
    write(ALICE, sessionId, 'l')
    expect(noteTyping).not.toHaveBeenCalled()
    expect(fake.sent).toEqual([])

    // …and the moment somebody else joins, the very next keystroke is attributed.
    presenceHub.join(BOB, 'browser')
    write(ALICE, sessionId, 's')
    expect(noteTyping.mock.calls).toEqual([[ALICE, 'node-42']])
  })
})
