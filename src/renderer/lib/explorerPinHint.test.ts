import { describe, expect, it } from 'vitest'
import {
  EXPLORER_PIN_HINT_KEY,
  readSeenExplorerPinHint,
  shouldShowExplorerPinHint,
  writeSeenExplorerPinHint
} from './explorerPinHint'

const base = { wasOpen: true, isOpenAfter: false, pinned: false, openedFile: true, seen: false }

describe('shouldShowExplorerPinHint', () => {
  it('fires on the painful close: unpinned, a file was opened, first time', () => {
    expect(shouldShowExplorerPinHint(base)).toBe(true)
  })

  it('never fires twice', () => {
    expect(shouldShowExplorerPinHint({ ...base, seen: true })).toBe(false)
  })

  it('a pinned drawer closing (the ×) does not hint — its owner already knows the pin', () => {
    expect(shouldShowExplorerPinHint({ ...base, pinned: true })).toBe(false)
  })

  it('a browse-and-dismiss close (no file opened) does not hint', () => {
    expect(shouldShowExplorerPinHint({ ...base, openedFile: false })).toBe(false)
  })

  it('only a real open→closed transition qualifies', () => {
    expect(shouldShowExplorerPinHint({ ...base, wasOpen: false })).toBe(false)
    expect(shouldShowExplorerPinHint({ ...base, isOpenAfter: true })).toBe(false)
  })
})

describe('seen flag storage', () => {
  it('round-trips through the injected store', () => {
    const store = new Map<string, string>()
    expect(readSeenExplorerPinHint((k) => store.get(k) ?? null)).toBe(false)
    writeSeenExplorerPinHint((k, v) => store.set(k, v))
    expect(store.get(EXPLORER_PIN_HINT_KEY)).toBe('1')
    expect(readSeenExplorerPinHint((k) => store.get(k) ?? null)).toBe(true)
  })

  it('an unreadable store reads as SEEN (never loop the one-shot), and writes never throw', () => {
    expect(
      readSeenExplorerPinHint(() => {
        throw new Error('private mode')
      })
    ).toBe(true)
    expect(() =>
      writeSeenExplorerPinHint(() => {
        throw new Error('quota')
      })
    ).not.toThrow()
  })
})
