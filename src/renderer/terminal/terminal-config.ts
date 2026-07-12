/**
 * Pure decisions behind the xterm instance in `TerminalNode` — extracted so they can be
 * tested without an xterm/DOM harness.
 */

/** Hard cap on xterm's in-memory scrollback: the cost is per node and one canvas holds many. */
export const XTERM_SCROLLBACK_MAX = 10000

/**
 * Floor, mirroring the tmux conf's own `history-limit ${Math.max(1000, scrollback)}`. Without it a
 * user who sets `tmuxScrollback: 100` would get 1000 lines of tmux history but a 100-line xterm
 * buffer — and xterm is the buffer the user actually scrolls, so the tmux history would be
 * unreachable.
 */
export const XTERM_SCROLLBACK_MIN = 1000

/**
 * How many scrollback lines xterm keeps. Scrolling is xterm's job now (tmux's mouse is off),
 * so it needs a real scrollback — xterm's default is only 1000 lines. It follows the same
 * `settings.tmuxScrollback` the user picked for tmux's history-limit, but floored and capped
 * (same floor as the tmux conf, so the two buffers never disagree at the low end).
 */
export function xtermScrollback(tmuxScrollback: number): number {
  return Math.min(Math.max(XTERM_SCROLLBACK_MIN, tmuxScrollback), XTERM_SCROLLBACK_MAX)
}

/**
 * What a freshly-created xterm has to be seeded with when its session resolves:
 * - `cold-snapshot` — the tmux session is gone (first open after a reboot): replay the persisted
 *   scrollback snapshot, with a "session restored" separator.
 * - `warm-history`  — the tmux session is still alive but this xterm is new (app restart): tmux
 *   only redraws the VISIBLE screen, so pull everything above it from tmux's own history.
 * - `none`          — nothing to seed: a parked terminal keeps its buffer (seeding would duplicate
 *   it), and a brand-new node with an `initialCommand` has no history to restore.
 */
export type AttachReplay = 'cold-snapshot' | 'warm-history' | 'none'

/** Which seeding (if any) applies to a terminal that just attached. */
export function attachReplay(opts: {
  /** The xterm instance was adopted from the park cache — its buffer is already correct. */
  parked: boolean
  /** The tmux session did not exist and was created by this attach. */
  fresh: boolean
  /** The node carries a one-shot launch command, i.e. it is being opened for the first time. */
  hasInitialCommand: boolean
}): AttachReplay {
  if (opts.parked) return 'none'
  if (!opts.fresh) return 'warm-history'
  return opts.hasInitialCommand ? 'none' : 'cold-snapshot'
}

/**
 * Make text captured from tmux (`capture-pane`, LF-separated lines) safe to `term.write()`.
 * xterm runs with `convertEol: false` — a bare LF moves down but keeps the column, so raw capture
 * output would render as a staircase. Lone LFs become CRLF; existing CRLFs are left alone.
 */
export function toXtermText(text: string): string {
  return text.replace(/\r?\n/g, '\r\n')
}

/**
 * Drop exactly ONE trailing newline from a tmux capture.
 * `capture-pane -p -e -S -<n>` emits a trailing LF after its last line. Writing it would leave the
 * cursor one row BELOW the last captured row: xterm scrolls, the topmost row of the captured
 * visible screen is pushed into scrollback, and tmux's attach redraw (`\x1b[H\x1b[2J`) then
 * repaints that same screen — so on every warm reattach the first visible row would appear twice.
 * Strip on the RAW capture (LF-separated), before `toXtermText` turns the LFs into CRLFs.
 */
export function stripTrailingNewline(text: string): string {
  return text.replace(/\r?\n$/, '')
}

/**
 * What a spawn continuation must do when it finds the effect already cleaned up while an async
 * seed (scrollback snapshot / tmux history) was in flight.
 * - `proceed`         — still mounted: carry on.
 * - `continue-parked` — the cleanup PARKED this very session (the park entry holds the same live
 *   xterm, PTY client and `cleanups` array). Killing or unsubscribing here would leave the node
 *   permanently dead when it is re-adopted, so the setup must simply finish.
 * - `teardown`        — a real unmount/delete: nothing holds this session, so drop the data
 *   listener and kill the PTY client.
 */
export type DisposalAction = 'proceed' | 'continue-parked' | 'teardown'

/**
 * The lifetime of one PTY session as seen by the effect that created it. It is SHARED with the
 * park entry the effect's cleanup hands the session off to (and with the effect that later adopts
 * that entry), so `dead` means "this session's xterm/PTY have been torn down for good" no matter
 * who did it.
 */
export interface SessionLife {
  dead: boolean
}

/**
 * The question is NOT "is something parked under this node id?" — an adoption removes the park
 * entry from the map, so a park followed by a remount looks exactly like "never parked", and
 * killing there would detach the PTY client of the terminal the user is looking at.
 * The right question is closure state: "did THIS effect's cleanup hand the session off to a park
 * entry that is still alive?". If it did, the session lives on (parked, or already re-adopted by a
 * remount that deliberately re-wires nothing and relies on this continuation to finish the job) —
 * so the setup must simply complete.
 */
export function disposalAction(opts: {
  /** The effect cleanup has run. */
  disposed: boolean
  /** The park entry THIS effect's cleanup created, if it parked the session (else null). */
  handedOff: SessionLife | null | undefined
}): DisposalAction {
  if (!opts.disposed) return 'proceed'
  return opts.handedOff && !opts.handedOff.dead ? 'continue-parked' : 'teardown'
}

/** A gate that holds PTY chunks back until the emulator has been seeded. */
export interface DataGate {
  /** Queue (while closed) or write straight through (once open). */
  push(chunk: string): void
  /** Drain the queue in arrival order and switch to pass-through. Idempotent. */
  open(): void
}

/**
 * Buffer PTY output that arrives while an async seed (scrollback snapshot / tmux history) is in
 * flight. The main process does NOT buffer: it pushes `pty:data:<sid>` on a timer whether or not
 * anyone is listening, and an IPC event with no listener is simply dropped. So we must subscribe
 * BEFORE awaiting the seed and park the chunks here — on a warm reattach tmux emits its redraw
 * within tens of ms, well inside a subprocess/ssh round-trip. Once the seed is written, `open()`
 * replays the queue in order and later chunks stream straight through.
 */
export function createDataGate(write: (chunk: string) => void): DataGate {
  let queued: string[] | null = []
  return {
    push(chunk) {
      if (queued) queued.push(chunk)
      else write(chunk)
    },
    open() {
      const pendingChunks = queued
      queued = null // pass-through first, so a re-entrant push during the drain stays in order
      pendingChunks?.forEach(write)
    }
  }
}

/** The subset of a KeyboardEvent the copy-shortcut decision looks at. */
export interface CopyShortcutEvent {
  type: string
  key: string
  code: string
  metaKey: boolean
  ctrlKey: boolean
  altKey: boolean
  shiftKey: boolean
}

/**
 * True for the keydowns that should copy the terminal selection: Cmd+C (mac), Ctrl+Shift+C
 * (Linux, Windows) and Ctrl+Insert (the traditional terminal binding — the only one of the three
 * that no browser reserves). Plain Ctrl+C is deliberately NOT one of them — it must keep reaching
 * the pty as SIGINT.
 *
 * The letter is matched on the printed key (`e.key`, so Dvorak/AZERTY follow the letter the user
 * actually presses) OR on the physical `KeyC` position (`e.code`) — on a non-Latin layout
 * (Cyrillic 'с', Greek 'ψ') `e.key` is never 'c', and without the fallback an xterm selection
 * would have no keyboard copy at all (the OS Edit menu only copies the DOM selection, not
 * xterm's canvas one).
 *
 * Cmd+Shift+C is deliberately allowed as well: nothing else binds it and it is a harmless
 * near-miss of Cmd+C. AltGr combos (which report ctrl+alt) never copy.
 */
export function isCopyShortcut(e: CopyShortcutEvent): boolean {
  if (e.type !== 'keydown') return false
  const insert = e.key === 'Insert' || e.code === 'Insert'
  const letterC = e.key.toLowerCase() === 'c' || e.code === 'KeyC'
  if (!insert && !letterC) return false
  if (insert) {
    // Ctrl+Insert = copy (Shift+Insert is paste — not ours). No meta/alt.
    return e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey
  }
  const cmdC = e.metaKey && !e.ctrlKey && !e.altKey
  const ctrlShiftC = e.ctrlKey && e.shiftKey && !e.metaKey && !e.altKey
  return cmdC || ctrlShiftC
}

/**
 * What a terminal keydown that MIGHT be a copy chord should do:
 * - `copy`    — it is a copy chord and there is a selection: copy it, swallow the key.
 * - `swallow` — it is a copy chord with NO selection: still swallow it. Critical for Ctrl+Shift+C:
 *   letting it through means xterm maps ctrl+c to `\x03` and SIGINTs the foreground process. We
 *   advertise the chord as "copy", so pressing it right after a click cleared the selection must
 *   never kill the user's process.
 * - `pass`    — not a copy chord: xterm handles it as usual.
 */
export type CopyKeyAction = 'copy' | 'swallow' | 'pass'

export function copyKeyAction(e: CopyShortcutEvent, hasSelection: boolean): CopyKeyAction {
  if (!isCopyShortcut(e)) return 'pass'
  return hasSelection ? 'copy' : 'swallow'
}
