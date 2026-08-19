import { describe, it, expect } from 'vitest'
import { IPC } from './ipc'
import { HOST_ONLY_REFUSAL, isHostOnlyChannel } from './host-control'

/**
 * The ONE list both shells consult. It exists so the desktop's relay admission and any future
 * shell cannot drift: a channel that only the host's own human may reach is named here, not in a
 * per-shell `startsWith` that one of them forgets to copy.
 */
describe('isHostOnlyChannel', () => {
  it('covers the whole GitHub host-control namespace by prefix', () => {
    expect(isHostOnlyChannel(IPC.githubControlApprove)).toBe(true)
    expect(isHostOnlyChannel(IPC.githubControlSaveToken)).toBe(true)
    // A namespace, not a fixed list: a method added later is gated the day it is added.
    expect(isHostOnlyChannel('githubControl:something-new')).toBe(true)
  })

  it('covers the three project-setup channels that can START or APPROVE a shared script', () => {
    expect(isHostOnlyChannel(IPC.projectSetupRun)).toBe(true)
    expect(isHostOnlyChannel(IPC.projectSetupConsentSubmit)).toBe(true)
    expect(isHostOnlyChannel(IPC.projectSetupCancel)).toBe(true)
  })

  it('covers request-trust too — it RAISES the host’s own consent prompt', () => {
    // A guest that could cast this one would be able to put a dialog on the host's screen at will
    // (prompt spam), and — paired with an admitted consent-submit — approve a shared launchCmd/env
    // for the host's own agent launches. Same self-approval loop as run+consent-submit.
    expect(isHostOnlyChannel(IPC.projectSetupRequestTrust)).toBe(true)
  })

  it('leaves the read-only/lifecycle channels alone — the gate is on ACTION, not on the namespace', () => {
    // Subscribing and receiving events costs a guest nothing the canvas does not already show;
    // running host code, and answering the host's own trust prompt, are the two acts being gated.
    expect(isHostOnlyChannel(IPC.projectSetupSubscribe)).toBe(false)
    expect(isHostOnlyChannel(IPC.projectSetupUnsubscribe)).toBe(false)
    expect(isHostOnlyChannel(IPC.projectSetupEvent('p1'))).toBe(false)
    expect(isHostOnlyChannel(IPC.ptyWrite)).toBe(false)
    // Near-misses must not be swallowed by a sloppy prefix.
    expect(isHostOnlyChannel('project-setup:run-something-else')).toBe(false)
    expect(isHostOnlyChannel('notgithubControl:approve')).toBe(false)
  })

  it('carries the refusal wording the peer sees, so both shells answer identically', () => {
    expect(HOST_ONLY_REFUSAL).toBe('host-control method is not available to relay peers')
  })
})
