import { describe, expect, it } from 'vitest'
import {
  EXPLORER_PINNED_KEY,
  explorerIsOpen,
  explorerOverlayClickCloses,
  nextExplorerPin,
  nextExplorerShow,
  parseExplorerPinned,
  readExplorerPinned,
  writeExplorerPinned,
  type ExplorerPinState
} from './explorerPin'

const hidden: ExplorerPinState = { pinned: false, dismissed: false, open: false }
const modal: ExplorerPinState = { pinned: false, dismissed: false, open: true }
const docked: ExplorerPinState = { pinned: true, dismissed: false, open: true }
const dockedHidden: ExplorerPinState = { pinned: true, dismissed: true, open: false }
/** Launch after a previous pin: shown, but `open` was never set this session. */
const launchPinned: ExplorerPinState = { pinned: true, dismissed: false, open: false }

describe('parseExplorerPinned', () => {
  it('is off by default — missing must not dock the drawer on existing users', () => {
    expect(parseExplorerPinned(null)).toBe(false)
    expect(parseExplorerPinned('')).toBe(false)
    expect(parseExplorerPinned('0')).toBe(false)
    expect(parseExplorerPinned('true')).toBe(false)
    expect(parseExplorerPinned('1')).toBe(true)
  })
})

describe('readExplorerPinned / writeExplorerPinned', () => {
  it('reads the namespaced key and writes 1/0', () => {
    const store: Record<string, string> = {}
    expect(readExplorerPinned((k) => store[k] ?? null)).toBe(false)
    writeExplorerPinned(true, (k, v) => {
      store[k] = v
    })
    expect(store[EXPLORER_PINNED_KEY]).toBe('1')
    expect(readExplorerPinned((k) => store[k] ?? null)).toBe(true)
    writeExplorerPinned(false, (k, v) => {
      store[k] = v
    })
    expect(store[EXPLORER_PINNED_KEY]).toBe('0')
    expect(readExplorerPinned((k) => store[k] ?? null)).toBe(false)
  })

  it('degrades to unpinned when storage throws', () => {
    expect(
      readExplorerPinned(() => {
        throw new Error('blocked')
      })
    ).toBe(false)
    expect(() =>
      writeExplorerPinned(true, () => {
        throw new Error('quota')
      })
    ).not.toThrow()
  })
})

describe('explorerIsOpen', () => {
  it('uses `open` when unpinned and `!dismissed` when pinned', () => {
    expect(explorerIsOpen(hidden)).toBe(false)
    expect(explorerIsOpen(modal)).toBe(true)
    expect(explorerIsOpen(docked)).toBe(true)
    expect(explorerIsOpen(dockedHidden)).toBe(false)
    expect(explorerIsOpen(launchPinned)).toBe(true)
  })

  it('does not treat dismissed as closed when unpinned — dismissed is a pin-only hide', () => {
    // An unpinned modal with a leftover dismissed flag (stale after unpin) still follows `open`.
    expect(explorerIsOpen({ pinned: false, dismissed: true, open: true })).toBe(true)
    expect(explorerIsOpen({ pinned: false, dismissed: true, open: false })).toBe(false)
  })
})

describe('explorerOverlayClickCloses', () => {
  it('closes the modal scrim, never a pinned drawer', () => {
    expect(explorerOverlayClickCloses(false)).toBe(true)
    expect(explorerOverlayClickCloses(true)).toBe(false)
  })
})

describe('nextExplorerShow', () => {
  it('open/reveal shows without clearing a pin', () => {
    expect(nextExplorerShow(hidden, 'open')).toEqual({ dismissed: false, open: true })
    expect(nextExplorerShow(dockedHidden, 'reveal')).toEqual({ dismissed: false, open: true })
    expect(nextExplorerShow(dockedHidden, 'open')).toEqual({ dismissed: false, open: true })
  })

  it('close hides without touching the pin (caller keeps `pinned`)', () => {
    expect(nextExplorerShow(modal, 'close')).toEqual({ dismissed: true, open: false })
    expect(nextExplorerShow(docked, 'close')).toEqual({ dismissed: true, open: false })
  })

  it('toggle flips visibility', () => {
    expect(nextExplorerShow(hidden, 'toggle')).toEqual({ dismissed: false, open: true })
    expect(nextExplorerShow(modal, 'toggle')).toEqual({ dismissed: true, open: false })
    expect(nextExplorerShow(docked, 'toggle')).toEqual({ dismissed: true, open: false })
    expect(nextExplorerShow(dockedHidden, 'toggle')).toEqual({ dismissed: false, open: true })
    expect(nextExplorerShow(launchPinned, 'toggle')).toEqual({ dismissed: true, open: false })
  })
})

describe('nextExplorerPin', () => {
  it('pinning a modal (or a closed panel) docks and shows it', () => {
    expect(nextExplorerPin(modal)).toEqual({ pinned: true, dismissed: false, open: true })
    expect(nextExplorerPin(hidden)).toEqual({ pinned: true, dismissed: false, open: true })
  })

  it('unpinning a visible drawer keeps it as the modal, including the launch-pinned case', () => {
    // If this just flipped `pinned` and left `open` false, the drawer would vanish.
    expect(nextExplorerPin(launchPinned)).toEqual({ pinned: false, dismissed: false, open: true })
    expect(nextExplorerPin(docked)).toEqual({ pinned: false, dismissed: false, open: true })
  })

  it('unpinning a dismissed drawer stays hidden', () => {
    expect(nextExplorerPin(dockedHidden)).toEqual({ pinned: false, dismissed: false, open: false })
  })
})
