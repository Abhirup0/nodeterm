import { describe, it, expect } from 'vitest'
import { confirmKeyAction, CONFIRM_ARM_MS, type ConfirmKeyContext } from './confirm-key'

/** A key the user aimed at the dialog they are looking at, well after it appeared. */
const aimedHere = (over: Partial<ConfirmKeyContext> = {}): ConfirmKeyContext => ({
  key: 'Enter',
  repeat: false,
  top: true,
  inDialog: true,
  sinceMount: 5_000,
  enterConfirms: true,
  ...over
})

describe('confirmKeyAction', () => {
  it('confirms an Enter the user aimed at the dialog they opened and can see', () => {
    expect(confirmKeyAction(aimedHere())).toBe('confirm')
  })

  // THE EXPLOIT. The user is typing in a terminal (or a chat box / rename field / palette — none of
  // them dialogs, so no stack guard is engaged); an agent's `close-worktree --mode remove` mounts
  // the removal dialog under their hands. The keydown bubbles to `window` either way — the only
  // thing that distinguishes it is WHERE IT WAS AIMED.
  it('ignores an Enter aimed at a terminal, even when this is the only dialog on screen', () => {
    expect(confirmKeyAction(aimedHere({ inDialog: false }))).toBeNull()
  })

  // …and a keystroke already in flight when the dialog appeared cannot be caught by it either,
  // however the focus lands.
  it('ignores keys during the arming window after mount', () => {
    expect(confirmKeyAction(aimedHere({ sinceMount: 0 }))).toBeNull()
    expect(confirmKeyAction(aimedHere({ sinceMount: CONFIRM_ARM_MS - 1 }))).toBeNull()
    expect(confirmKeyAction(aimedHere({ sinceMount: CONFIRM_ARM_MS }))).toBe('confirm')
  })

  it('ignores a held-down key (auto-repeat is not an answer)', () => {
    expect(confirmKeyAction(aimedHere({ repeat: true }))).toBeNull()
  })

  // A dialog the app raised on an AGENT's behalf is not answered by a keystroke at all: the user
  // never asked for it, so they must look at it and click.
  it('never confirms an agent-initiated dialog by keyboard, but still cancels it', () => {
    expect(confirmKeyAction(aimedHere({ enterConfirms: false }))).toBeNull()
    expect(confirmKeyAction(aimedHere({ enterConfirms: false, key: 'Escape' }))).toBe('cancel')
  })

  it('never acts for a dialog that is not on top (the user is answering the one above it)', () => {
    expect(confirmKeyAction(aimedHere({ top: false }))).toBeNull()
    expect(confirmKeyAction(aimedHere({ top: false, key: 'Escape' }))).toBeNull()
  })

  // Escape only ever cancels — the worst it can do is make the user ask again — so it is not gated
  // on the target or the arming window.
  it('cancels on Escape from anywhere, immediately', () => {
    expect(confirmKeyAction(aimedHere({ key: 'Escape', inDialog: false, sinceMount: 0 }))).toBe(
      'cancel'
    )
  })

  it('ignores every other key', () => {
    expect(confirmKeyAction(aimedHere({ key: 'a' }))).toBeNull()
    expect(confirmKeyAction(aimedHere({ key: ' ' }))).toBeNull()
  })
})
