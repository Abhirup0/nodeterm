import { describe, it, expect, beforeEach } from 'vitest'
import {
  isTopDialog,
  nextDialogId,
  openDialogCount,
  popDialog,
  pushDialog,
  resetDialogStack
} from './dialog-stack'

beforeEach(() => resetDialogStack())

describe('dialog stack (which dialog owns Enter/Escape)', () => {
  it('a lone dialog owns the keyboard', () => {
    const a = nextDialogId()
    pushDialog(a)
    expect(isTopDialog(a)).toBe(true)
  })

  it('the exploit pairing: the dialog underneath does NOT answer the key', () => {
    // 1. agent: close-worktree --mode remove → the destructive dialog mounts…
    const remove = nextDialogId()
    pushDialog(remove)
    // 2. agent: write → the benign "Agent wants to send…" dialog mounts on top (portals paint in
    //    mount order), hiding it.
    const send = nextDialogId()
    pushDialog(send)
    // 3. the user presses Enter at the dialog they can see. Only that one may act.
    expect(isTopDialog(send)).toBe(true)
    expect(isTopDialog(remove)).toBe(false) // ← the worktree survives
  })

  it('closing the top hands the keyboard back to the one below', () => {
    const a = nextDialogId()
    const b = nextDialogId()
    pushDialog(a)
    pushDialog(b)
    popDialog(b)
    expect(isTopDialog(a)).toBe(true)
    expect(openDialogCount()).toBe(1)
  })

  it('an out-of-order unmount keeps the remaining order intact', () => {
    const a = nextDialogId()
    const b = nextDialogId()
    const c = nextDialogId()
    pushDialog(a)
    pushDialog(b)
    pushDialog(c)
    popDialog(b) // the middle one closes first
    expect(isTopDialog(c)).toBe(true)
    popDialog(c)
    expect(isTopDialog(a)).toBe(true)
  })

  it('no dialog is top when none is open, and ids are unique', () => {
    const a = nextDialogId()
    expect(isTopDialog(a)).toBe(false)
    expect(nextDialogId()).not.toBe(nextDialogId())
  })

  it('push is idempotent (a re-registered dialog does not double-stack)', () => {
    const a = nextDialogId()
    pushDialog(a)
    pushDialog(a)
    expect(openDialogCount()).toBe(1)
    popDialog(a)
    expect(openDialogCount()).toBe(0)
  })
})
