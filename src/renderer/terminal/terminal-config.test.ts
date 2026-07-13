import { describe, it, expect, beforeEach } from 'vitest'
import {
  attachReplay,
  closedByLabel,
  copyKeyAction,
  createDataGate,
  disposalAction,
  forgetNodeTermState,
  isCopyShortcut,
  isLetterboxed,
  letterboxFor,
  markRecycled,
  recycleAction,
  repaintResync,
  reportedSize,
  seedPaint,
  setFittedSize,
  shouldApplyResync,
  stripTrailingNewline,
  takeRecycled,
  toXtermText,
  xtermScrollback,
  RESYNC_NOTICE,
  XTERM_SCROLLBACK_MAX,
  XTERM_SCROLLBACK_MIN,
  type CopyShortcutEvent
} from './terminal-config'
import type { ClientId } from '@shared/presence'

const ev = (p: Partial<CopyShortcutEvent>): CopyShortcutEvent => ({
  type: 'keydown',
  key: 'c',
  code: 'KeyC',
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...p
})

describe('reportedSize', () => {
  it('reports the fit proposal, floored at 1 (a collapsed node can propose 0)', () => {
    expect(reportedSize({ cols: 132, rows: 43 })).toEqual({ cols: 132, rows: 43 })
    expect(reportedSize({ cols: 0, rows: 0 })).toEqual({ cols: 1, rows: 1 })
  })

  it('returns null when the fit cannot be measured (hidden / zero-size node)', () => {
    expect(reportedSize(undefined)).toBeNull()
    expect(reportedSize(null)).toBeNull()
    expect(reportedSize({ cols: NaN, rows: 24 })).toBeNull()
    expect(reportedSize({ cols: 80, rows: Infinity })).toBeNull()
    expect(reportedSize({ cols: 80 })).toBeNull()
  })
})

describe('isLetterboxed', () => {
  it('is false for a solo user: the effective size IS their own fit', () => {
    expect(isLetterboxed({ cols: 100, rows: 30 }, { cols: 100, rows: 30 })).toBe(false)
  })

  it('is true when the pty runs at a smaller subscriber s grid', () => {
    expect(isLetterboxed({ cols: 80, rows: 30 }, { cols: 100, rows: 30 })).toBe(true)
    expect(isLetterboxed({ cols: 100, rows: 24 }, { cols: 100, rows: 30 })).toBe(true)
  })

  it('is false while our own fit is unknown (nothing to letterbox against)', () => {
    expect(isLetterboxed({ cols: 80, rows: 24 }, null)).toBe(false)
  })
})

describe('shouldApplyResync', () => {
  it('paints a non-empty capture', () => {
    expect(shouldApplyResync('$ ls\nfoo\n')).toBe(true)
  })

  it('IGNORES an empty/absent payload — a wrongly reset screen is unrecoverable', () => {
    expect(shouldApplyResync('')).toBe(false)
    expect(shouldApplyResync(null)).toBe(false)
    expect(shouldApplyResync(undefined)).toBe(false)
  })
})

describe('attachReplay', () => {
  it('replays the persisted snapshot on a cold start (tmux session gone)', () => {
    expect(attachReplay({ parked: false, fresh: true, hasInitialCommand: false })).toBe('cold-snapshot')
  })

  it('seeds nothing on a warm reattach — tmux redraws the pane and owns its history', () => {
    expect(attachReplay({ parked: false, fresh: false, hasInitialCommand: false })).toBe('warm-attach')
  })

  it('seeds nothing on a brand-new node (fresh session + launch command)', () => {
    expect(attachReplay({ parked: false, fresh: true, hasInitialCommand: true })).toBe('none')
  })

  it('seeds nothing for a parked terminal — its buffer is already correct', () => {
    // Both fresh values: an adopted xterm must never be seeded, or the content would double.
    expect(attachReplay({ parked: true, fresh: false, hasInitialCommand: false })).toBe('none')
    expect(attachReplay({ parked: true, fresh: true, hasInitialCommand: false })).toBe('none')
    expect(attachReplay({ parked: true, fresh: true, hasInitialCommand: true })).toBe('none')
  })
})

describe('toXtermText', () => {
  it('turns tmux capture LFs into CRLFs, leaving existing CRLFs alone', () => {
    expect(toXtermText('a\nb')).toBe('a\r\nb')
    expect(toXtermText('a\r\nb')).toBe('a\r\nb')
  })

  it('turns tmux capture-pane LFs into CRLFs (xterm runs with convertEol off)', () => {
    expect(toXtermText('one\ntwo\n')).toBe('one\r\ntwo\r\n')
  })

  it('leaves existing CRLFs alone', () => {
    expect(toXtermText('one\r\ntwo')).toBe('one\r\ntwo')
  })

  it('keeps escape sequences untouched', () => {
    expect(toXtermText('\x1b[31mred\x1b[0m\n')).toBe('\x1b[31mred\x1b[0m\r\n')
  })
})

describe('closedByLabel', () => {
  const peers = { 7: { name: 'Ada' } } as Record<ClientId, { name: string }>

  it('names the peer who destroyed the node', () => {
    expect(closedByLabel(7 as ClientId, peers)).toBe('Ada')
  })

  it('degrades to a neutral label for an unattributed destroy or an unknown/departed peer', () => {
    expect(closedByLabel(null, peers)).toBe('another user')
    expect(closedByLabel(99 as ClientId, peers)).toBe('another user')
  })
})

// The fitted size is read by the pty:size listener, which is wired ONCE and SURVIVES a park
// (the terminal is adopted by a later mount with its listeners intact). It therefore may not
// live in the mounting effect's closure: after a park/adopt, the listener would keep measuring
// the letterbox against the PRE-PARK grid — so a co-viewer who parks, changes the font size and
// comes back gets a letterbox he shouldn't have (or loses one he should).
describe('fitted-size registry (survives a park, like the listeners that read it)', () => {
  beforeEach(() => forgetNodeTermState('n1'))

  it('measures the letterbox against the fit of the CURRENTLY mounted terminal', () => {
    // Mount A fits 120×40 and wires the pty:size listener.
    setFittedSize('n1', { cols: 120, rows: 40 })
    const onSize = (size: { cols: number; rows: number }): boolean => letterboxFor('n1', size)
    expect(onSize({ cols: 80, rows: 24 })).toBe(true) // a smaller co-viewer clamps us → letterbox

    // Park + adopt: the SAME listener lives on, but the user bumped the font size, so mount B
    // fits a smaller grid — which is now exactly the pty's size. No letterbox.
    setFittedSize('n1', { cols: 80, rows: 24 })
    expect(onSize({ cols: 80, rows: 24 })).toBe(false)
  })

  it('reports no letterbox for a node that has never reported a fit', () => {
    expect(letterboxFor('never-fitted', { cols: 80, rows: 24 })).toBe(false)
  })

  it('forgets a node on permanent deletion (a recycled node id must not inherit a stale fit)', () => {
    setFittedSize('n1', { cols: 200, rows: 60 })
    forgetNodeTermState('n1')
    expect(letterboxFor('n1', { cols: 80, rows: 24 })).toBe(false)
  })
})

// The "session restarted by another user" banner is armed when the recycle notice lands and must
// be CONSUMED by the spawn it belongs to — even when that spawn is abandoned (the node unmounted
// while create() was in flight). A flag left behind would print the banner on some unrelated
// mount hours later.
describe('recycle banner flag', () => {
  beforeEach(() => forgetNodeTermState('n1'))

  it('is consumed exactly once', () => {
    markRecycled('n1')
    expect(takeRecycled('n1')).toBe(true)
    expect(takeRecycled('n1')).toBe(false)
  })

  it('is false for a node that was never recycled', () => {
    expect(takeRecycled('n1')).toBe(false)
  })

  it('is dropped with the node (no stale banner on a much later mount)', () => {
    markRecycled('n1')
    forgetNodeTermState('n1')
    expect(takeRecycled('n1')).toBe(false)
  })
})

// The recycle notice carries whether a REPLACEMENT session is already live. Without one (the
// recycler crashed between the kill and the create), restarting would spawn `nt-<id>` from this
// client's own — stale — cwd, silently undoing the worktree move for everybody. So: only restart
// when there is something to restart onto.
describe('recycleAction', () => {
  it('restarts onto the replacement session when it is live', () => {
    expect(recycleAction({ ready: true })).toBe('restart')
  })

  it('ends the terminal (reopen to restart) when no replacement was ever registered', () => {
    expect(recycleAction({ ready: false })).toBe('ended')
  })

  it('treats a payload-less/legacy notice as "no replacement" (never spawn in a stale cwd)', () => {
    expect(recycleAction(undefined)).toBe('ended')
  })
})

describe('stripTrailingNewline', () => {
  it('drops exactly one trailing LF (tmux capture-pane ends with one)', () => {
    expect(stripTrailingNewline('one\ntwo\n')).toBe('one\ntwo')
  })

  it('drops a trailing CRLF as a unit', () => {
    expect(stripTrailingNewline('one\r\n')).toBe('one')
  })

  it('keeps blank lines that precede the final one (only ONE newline goes)', () => {
    expect(stripTrailingNewline('one\n\n\n')).toBe('one\n\n')
  })

  it('leaves text without a trailing newline alone', () => {
    expect(stripTrailingNewline('one\ntwo')).toBe('one\ntwo')
    expect(stripTrailingNewline('')).toBe('')
  })

  it('composes with toXtermText so the seed leaves the cursor on the LAST captured row', () => {
    // Writing the trailing newline would push the cursor one row down: xterm scrolls, the top row
    // of the captured visible screen lands in scrollback, and tmux's redraw repaints it again —
    // one duplicated line at the seam on every warm reattach.
    expect(toXtermText(stripTrailingNewline('one\ntwo\n'))).toBe('one\r\ntwo')
  })
})

describe('disposalAction', () => {
  it('proceeds while the node is still mounted', () => {
    expect(disposalAction({ disposed: false, handedOff: null })).toBe('proceed')
  })

  it('continues the setup when the cleanup PARKED this session', () => {
    // Project switch during the hydration await: the park entry holds the same xterm, PTY client
    // and cleanups array, so the session is alive and must be finished wiring — killing it here
    // would leave a permanently dead node when the user switches back.
    expect(disposalAction({ disposed: true, handedOff: { dead: false } })).toBe('continue-parked')
  })

  it('continues the setup when the parked session was already ADOPTED by a remount', () => {
    // Park-then-adopt inside one hydration await: the remount takes the entry out of the parked
    // map and deliberately re-wires nothing — it relies on THIS continuation to open the gate and
    // attach onExit/onData. The handed-off entry is still alive (not dead), so: continue.
    const handedOff = { dead: false } // adoption does not kill; it only removes the map entry
    expect(disposalAction({ disposed: true, handedOff })).toBe('continue-parked')
  })

  it('tears down on a real unmount/delete (the cleanup handed nothing off)', () => {
    expect(disposalAction({ disposed: true, handedOff: null })).toBe('teardown')
    expect(disposalAction({ disposed: true, handedOff: undefined })).toBe('teardown')
  })

  it('tears down when the handed-off session was disposed for good (park expiry / delete)', () => {
    expect(disposalAction({ disposed: true, handedOff: { dead: true } })).toBe('teardown')
  })
})

describe('createDataGate', () => {
  it('queues chunks that arrive before the gate opens, then drains them in order', () => {
    const written: string[] = []
    const gate = createDataGate((c) => written.push(c))
    gate.push('a')
    gate.push('b')
    expect(written).toEqual([]) // nothing reaches the emulator while the hydration is in flight
    gate.open()
    expect(written).toEqual(['a', 'b'])
  })

  it('writes straight through once open', () => {
    const written: string[] = []
    const gate = createDataGate((c) => written.push(c))
    gate.open()
    gate.push('a')
    gate.push('b')
    expect(written).toEqual(['a', 'b'])
  })

  it('is idempotent on open (a second open cannot replay the queue)', () => {
    const written: string[] = []
    const gate = createDataGate((c) => written.push(c))
    gate.push('a')
    gate.open()
    gate.open()
    expect(written).toEqual(['a'])
  })

  it('keeps ordering when a chunk arrives during the drain', () => {
    const written: string[] = []
    const gate: ReturnType<typeof createDataGate> = createDataGate((c) => {
      written.push(c)
      if (c === 'a') gate.push('b') // re-entrant push while draining
    })
    gate.push('a')
    gate.open()
    expect(written).toEqual(['a', 'b'])
  })

  // A `pty:resync` repaints the CURRENT screen from tmux. Anything the gate is still holding
  // predates that capture, so draining it would splice the stale flood back over the fresh screen —
  // the terminal would end up showing output the redraw exists to skip.
  it('DISCARDS the queue on reset (a resync supersedes everything that predates it)', () => {
    const written: string[] = []
    const gate = createDataGate((c) => written.push(c))
    gate.push('stale-1')
    gate.push('stale-2')
    expect(gate.reset()).toBe('stale-1'.length + 'stale-2'.length) // bytes owed back to flow control
    gate.open() // the seed's `finally` still runs — it must not resurrect the dropped chunks
    expect(written).toEqual([])
  })

  it('passes through after a reset (post-capture output must keep streaming)', () => {
    const written: string[] = []
    const gate = createDataGate((c) => written.push(c))
    gate.push('stale')
    gate.reset()
    gate.push('fresh')
    expect(written).toEqual(['fresh'])
  })

  it('reports nothing dropped when the gate is already open', () => {
    const written: string[] = []
    const gate = createDataGate((c) => written.push(c))
    gate.open()
    gate.push('a')
    expect(gate.reset()).toBe(0)
    expect(written).toEqual(['a'])
  })
})

describe('xtermScrollback', () => {
  it('follows the tmux scrollback setting below the cap', () => {
    expect(xtermScrollback(2000)).toBe(2000)
  })

  it('caps the default 50000-line tmux scrollback', () => {
    expect(xtermScrollback(50000)).toBe(XTERM_SCROLLBACK_MAX)
    expect(XTERM_SCROLLBACK_MAX).toBe(10000)
  })

  it('floors a tiny setting the same way the tmux conf does (history-limit max(1000, n))', () => {
    // tmux would still keep 1000 lines of history — an xterm buffer smaller than that would make
    // them unreachable, since xterm is the buffer the user scrolls.
    expect(XTERM_SCROLLBACK_MIN).toBe(1000)
    expect(xtermScrollback(100)).toBe(XTERM_SCROLLBACK_MIN)
    expect(xtermScrollback(0)).toBe(XTERM_SCROLLBACK_MIN)
  })
})

describe('isCopyShortcut', () => {
  it('copies on Cmd+C', () => {
    expect(isCopyShortcut(ev({ metaKey: true }))).toBe(true)
  })

  it('copies on Ctrl+Shift+C', () => {
    expect(isCopyShortcut(ev({ ctrlKey: true, shiftKey: true }))).toBe(true)
  })

  it('leaves plain Ctrl+C alone so it still sends SIGINT', () => {
    expect(isCopyShortcut(ev({ ctrlKey: true }))).toBe(false)
  })

  it('ignores other keys, keyups and extra modifiers', () => {
    expect(isCopyShortcut(ev({ metaKey: true, key: 'v', code: 'KeyV' }))).toBe(false)
    expect(isCopyShortcut(ev({ metaKey: true, type: 'keyup' }))).toBe(false)
    expect(isCopyShortcut(ev({ metaKey: true, altKey: true }))).toBe(false)
    expect(isCopyShortcut(ev({ ctrlKey: true, shiftKey: true, metaKey: true }))).toBe(false)
  })

  it('accepts an uppercase key (Shift makes Ctrl+Shift+C report "C")', () => {
    expect(isCopyShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'C' }))).toBe(true)
  })

  it('copies on a non-Latin layout, where e.key is not "c" (physical KeyC)', () => {
    // Cyrillic layout: the C key reports 'с' (U+0441), Greek reports 'ψ'.
    expect(isCopyShortcut(ev({ metaKey: true, key: 'с', code: 'KeyC' }))).toBe(true)
    expect(isCopyShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'с', code: 'KeyC' }))).toBe(true)
    expect(isCopyShortcut(ev({ ctrlKey: true, shiftKey: true, key: 'ψ', code: 'KeyC' }))).toBe(true)
    // Plain Ctrl on the same layout still reaches the pty as SIGINT.
    expect(isCopyShortcut(ev({ ctrlKey: true, key: 'с', code: 'KeyC' }))).toBe(false)
  })

  it('does not copy when neither the printed nor the physical key is C', () => {
    expect(isCopyShortcut(ev({ metaKey: true, key: 'ц', code: 'KeyW' }))).toBe(false)
  })

  it('copies on Cmd+Shift+C too (no competing binding; asserted, not accidental)', () => {
    expect(isCopyShortcut(ev({ metaKey: true, shiftKey: true }))).toBe(true)
  })

  it('leaves AltGr combos alone (ctrl+alt+shift+C must not copy)', () => {
    expect(isCopyShortcut(ev({ ctrlKey: true, altKey: true, shiftKey: true }))).toBe(false)
    expect(isCopyShortcut(ev({ ctrlKey: true, altKey: true }))).toBe(false)
  })

  it('copies on Ctrl+Insert (the traditional binding no browser reserves)', () => {
    expect(isCopyShortcut(ev({ ctrlKey: true, key: 'Insert', code: 'Insert' }))).toBe(true)
    // Shift+Insert is PASTE, not ours; bare Insert is a plain key.
    expect(isCopyShortcut(ev({ shiftKey: true, key: 'Insert', code: 'Insert' }))).toBe(false)
    expect(isCopyShortcut(ev({ key: 'Insert', code: 'Insert' }))).toBe(false)
    expect(
      isCopyShortcut(ev({ ctrlKey: true, altKey: true, key: 'Insert', code: 'Insert' }))
    ).toBe(false)
  })
})

describe('copyKeyAction', () => {
  it('copies a copy chord when there is a selection', () => {
    expect(copyKeyAction(ev({ metaKey: true }), true)).toBe('copy')
    expect(copyKeyAction(ev({ ctrlKey: true, shiftKey: true }), true)).toBe('copy')
  })

  it('SWALLOWS Ctrl+Shift+C with no selection — it must never reach the pty as SIGINT', () => {
    // Regression: falling through to xterm here maps ctrl+c to \x03 and kills the foreground
    // process, right after the user's selection was cleared by a click. We advertise the chord as
    // copy, so it can only ever copy or do nothing.
    expect(copyKeyAction(ev({ ctrlKey: true, shiftKey: true }), false)).toBe('swallow')
    expect(copyKeyAction(ev({ metaKey: true }), false)).toBe('swallow')
    expect(copyKeyAction(ev({ ctrlKey: true, key: 'Insert', code: 'Insert' }), false)).toBe(
      'swallow'
    )
  })

  it('passes plain Ctrl+C through to the pty (SIGINT), selection or not', () => {
    expect(copyKeyAction(ev({ ctrlKey: true }), true)).toBe('pass')
    expect(copyKeyAction(ev({ ctrlKey: true }), false)).toBe('pass')
  })
})

describe('seedPaint', () => {
  it('paints the snapshot on a cold restore, and nothing when there is none', () => {
    expect(seedPaint({ replay: 'cold-snapshot', superseded: false, snapshot: 'old' })).toBe(
      'snapshot'
    )
    expect(seedPaint({ replay: 'cold-snapshot', superseded: false, snapshot: '' })).toBe('none')
  })

  it('paints NOTHING on a plain warm reattach — tmux redraws the pane itself', () => {
    // Hydrating here is exactly what produced the black bands and duplicated screens: tmux is a
    // screen painter, and its repaints leaked into whatever we had seeded.
    expect(seedPaint({ replay: 'warm-attach', superseded: false })).toBe('none')
  })

  it("paints the create-result screen for a CO-ATTACH JOINER (it gets no tmux redraw)", () => {
    expect(
      seedPaint({ replay: 'warm-attach', superseded: false, screen: 'live screen' })
    ).toBe('create-screen')
    // No screen (a solo warm reattach, or a capture that came back empty): a blank-but-live
    // terminal beats a wrongly painted one — tmux paints it a moment later anyway.
    expect(seedPaint({ replay: 'warm-attach', superseded: false, screen: '' })).toBe('none')
  })

  it('paints nothing for a parked terminal (its buffer is already correct)', () => {
    expect(
      seedPaint({ replay: 'none', superseded: false, snapshot: 'old', screen: 'scr' })
    ).toBe('none')
  })

  it('a resync SUPERSEDES every seed: the decision is "write nothing", never "abort"', () => {
    // The whole point of the helper: a superseded seed still returns a PAINT decision, so the spawn
    // continuation carries on to wire onExit, term.onData (the keyboard input path) and the
    // initialCommand / agent resume. `none` is not a signal to return.
    for (const replay of ['cold-snapshot', 'warm-attach', 'none'] as const) {
      expect(
        seedPaint({
          replay,
          superseded: true,
          snapshot: 'old snapshot',
          screen: 'old screen'
        })
      ).toBe('none')
    }
  })
})

/** An xterm stand-in: `write` is PARSED ASYNCHRONOUSLY (callbacks fire on `parse()`). */
function fakeTerm(): {
  ops: string[]
  parse: () => void
  write(data: string, done?: () => void): void
  reset(): void
} {
  const queue: Array<() => void> = []
  return {
    ops: [] as string[],
    write(data: string, done?: () => void) {
      this.ops.push(`write:${data}`)
      if (done) queue.push(done)
    },
    reset() {
      this.ops.push('reset')
    },
    parse() {
      while (queue.length) queue.shift()!()
    }
  }
}

describe('repaintResync', () => {
  it('resets only AFTER the writes already queued have been parsed (never mid-flight)', () => {
    const term = fakeTerm()
    term.write('STALE HISTORY') // a seed already handed to xterm but not yet parsed
    repaintResync(term, 'FRESH')
    // Nothing repainted yet: an inline reset() would have cleared an almost-empty buffer and the
    // stale history would then parse on top of the cleared screen.
    expect(term.ops).toEqual(['write:STALE HISTORY', 'write:'])
    term.parse()
    expect(term.ops).toEqual([
      'write:STALE HISTORY',
      'write:',
      'reset',
      'write:FRESH',
      `write:${RESYNC_NOTICE}`
    ])
    const reset = term.ops.indexOf('reset')
    expect(reset).toBeGreaterThan(term.ops.indexOf('write:STALE HISTORY'))
    expect(reset).toBeLessThan(term.ops.indexOf('write:FRESH'))
  })

  it('CRLF-converts the capture (tmux emits bare LFs; xterm runs convertEol:false)', () => {
    const term = fakeTerm()
    repaintResync(term, 'a\nb')
    term.parse()
    expect(term.ops).toContain('write:a\r\nb')
  })

  it('touches NOTHING once the terminal is dead (the deferred reset outlives teardown)', () => {
    const term = fakeTerm()
    let dead = false
    repaintResync(term, 'FRESH', () => !dead)
    // Teardown: the node is destroyed while the zero-length write is still queued. The listener is
    // unsubscribed and the xterm disposed — but xterm's write loop still owns the callback.
    dead = true
    term.parse()
    // Only the zero-length probe write, which happened before teardown. No reset()/write() on a
    // disposed core (which throws inside xterm's async write loop).
    expect(term.ops).toEqual(['write:'])
  })

  it('still repaints while the terminal is alive (the guard is not a blanket no-op)', () => {
    const term = fakeTerm()
    repaintResync(term, 'FRESH', () => true)
    term.parse()
    expect(term.ops).toEqual(['write:', 'reset', 'write:FRESH', `write:${RESYNC_NOTICE}`])
  })

  it('coalesces back-to-back resyncs: only the LATEST capture is painted, once', () => {
    const term = fakeTerm()
    repaintResync(term, 'OLD')
    repaintResync(term, 'NEW') // lands before OLD's callback ran
    term.parse()
    // A stacked repaint would reset, paint OLD, reset, paint NEW — leaving OLD's parse output
    // spliced above NEW. Superseded captures are dropped instead: one reset, the newest screen.
    expect(term.ops).toEqual([
      'write:',
      'write:',
      'reset',
      'write:NEW',
      `write:${RESYNC_NOTICE}`
    ])
  })

  it('coalescing is per terminal and per round (a later, separate resync still paints)', () => {
    const term = fakeTerm()
    repaintResync(term, 'ONE')
    term.parse()
    repaintResync(term, 'TWO')
    term.parse()
    expect(term.ops.filter((o) => o === 'reset')).toHaveLength(2)
    expect(term.ops).toContain('write:ONE')
    expect(term.ops).toContain('write:TWO')
  })
})
