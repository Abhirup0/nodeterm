import type { ClientId } from '@shared/presence'

/**
 * Pure decisions behind the xterm instance in `TerminalNode` — extracted so they can be tested
 * without an xterm/DOM harness (vitest runs in the node environment; there is no jsdom).
 *
 * Everything here belongs to co-attach: one pty, N subscribers. The pty runs at the SMALLEST
 * subscriber's grid, so a terminal no longer owns its own size — it REPORTS what it could render
 * and RENDERS what the pty broadcasts back.
 */

/** A terminal grid. `null` cols/rows on the wire means "subscribed, but not viewing" (parked). */
export interface TermSize {
  cols: number
  rows: number
}

/**
 * The size a terminal REPORTS to the pty. Under co-attach the renderer proposes what it could
 * render (`FitAddon.proposeDimensions()`); the pty then broadcasts the min over all subscribers.
 * `null` means "unmeasurable right now" (a collapsed / zero-size node) — report NOTHING rather
 * than a bogus 0×0, which would clamp every other viewer's terminal to nothing.
 */
export function reportedSize(proposed: Partial<TermSize> | undefined | null): TermSize | null {
  if (!proposed) return null
  const { cols, rows } = proposed
  if (typeof cols !== 'number' || typeof rows !== 'number') return null
  if (!Number.isFinite(cols) || !Number.isFinite(rows)) return null
  return { cols: Math.max(1, Math.floor(cols)), rows: Math.max(1, Math.floor(rows)) }
}

/**
 * Are we rendering someone else's (smaller) grid? True when the authoritative size the pty
 * broadcast is smaller than what this node could fit — then the leftover space is letterboxed.
 * A solo user is always the min of a one-element set, so this is ALWAYS false for them and the
 * letterbox styling never engages: their terminal looks exactly as it did before co-attach.
 */
export function isLetterboxed(effective: TermSize, fitted: TermSize | null): boolean {
  if (!fitted) return false
  return effective.cols < fitted.cols || effective.rows < fitted.rows
}

/**
 * Per-node terminal state that must OUTLIVE a mount — because the transport listeners that read it
 * do. `TerminalNode` wires `onSize` / `onClosed` / `onRecycled` ONCE, in the spawn continuation,
 * and an adopted (parked) terminal carries those listeners into the next mount without
 * re-subscribing. Anything they read therefore cannot live in the mounting effect's closure: the
 * live listener would keep reading MOUNT A's variables while mount B updates its own.
 *
 * `fitted` is exactly that: the last size THIS client reported, and the reference the letterbox is
 * measured against (`letterboxFor`). Park, change the font size, come back — mount B fits a
 * different grid, and a closure-captured `fitted` would leave the surviving `onSize` listener
 * comparing the pty's size against the pre-park one, permanently letterboxing a terminal that
 * should fill its node (or un-letterboxing one that shouldn't).
 */
const fittedByNode = new Map<string, TermSize>()

/** Record what this client last REPORTED it can render (called from every applyFit). */
export function setFittedSize(nodeId: string, size: TermSize): void {
  fittedByNode.set(nodeId, size)
}

/** `isLetterboxed` against the CURRENT mount's fit — see `fittedByNode`. */
export function letterboxFor(nodeId: string, effective: TermSize): boolean {
  return isLetterboxed(effective, fittedByNode.get(nodeId) ?? null)
}

/**
 * Node ids whose next spawn is a recycle RESTART: the co-viewer's session was replaced under it
 * (someone moved the node into a worktree), and the new xterm prints a one-line reason — the
 * replacement is a fresh shell in a different folder, so the screen legitimately changes and a
 * silent reset would just look like a glitch.
 *
 * `takeRecycled` consumes the flag, and the spawn path consumes it BEFORE `create()` resolves: a
 * node that unmounts while its create is in flight abandons that spawn, and a flag left behind
 * would print "session restarted by another user" on some unrelated mount hours later.
 */
const recycledIds = new Set<string>()

export function markRecycled(nodeId: string): void {
  recycledIds.add(nodeId)
}

/** Consume the recycle flag: true exactly once per `markRecycled`. */
export function takeRecycled(nodeId: string): boolean {
  return recycledIds.delete(nodeId)
}

/** Drop every cross-mount trace of a node — called when it is permanently deleted. */
export function forgetNodeTermState(nodeId: string): void {
  fittedByNode.delete(nodeId)
  recycledIds.delete(nodeId)
}

/**
 * What a `pty:recycled` notice means for this terminal.
 *
 * `ready` says a REPLACEMENT session is already registered for the node, so restarting is safe:
 * our re-create co-attaches to it and we follow the node into its new cwd.
 *
 * Without one — the recycler's app died between the `tmux kill-session` and its own `create()`, so
 * the notice fired on the escape-hatch timeout — a restart would be actively harmful: our create
 * options still carry the node's OLD cwd (a cwd change is not broadcast to other clients), so we
 * would spawn `nt-<id>` in the stale directory, and the mover's app, on its return, would
 * `new-session -A` straight into it. Everyone's node would then claim the worktree path while the
 * shell sits in the old folder — the exact silent failure the withheld notice exists to prevent.
 * So we DON'T spawn: the terminal ends, and the user reopens it deliberately if they want a shell.
 */
export function recycleAction(info: { ready: boolean } | undefined): 'restart' | 'ended' {
  return info?.ready ? 'restart' : 'ended'
}

/**
 * Should a `pty:resync` payload be painted? The server promises never to send an empty capture,
 * but the renderer guards anyway: a resync RESETS the emulator, and a screen reset on an empty
 * payload is unrecoverable (the user loses the screen for nothing), while a skipped repaint is
 * not (the next byte of output redraws through tmux anyway).
 */
export function shouldApplyResync(screen: string | null | undefined): screen is string {
  return typeof screen === 'string' && screen.length > 0
}

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
/**
 * Make text captured from tmux (`capture-pane`, LF-separated lines) safe to `term.write()`.
 * xterm runs with `convertEol: false` — a bare LF moves down but keeps the column, so raw capture
 * output would render as a staircase. Lone LFs become CRLF; existing CRLFs are left alone.
 */
export function toXtermText(text: string): string {
  return text.replace(/\r?\n/g, '\r\n')
}

/**
 * Who closed this node, for the "closed by …" overlay. `by` is null when the destroy was not
 * attributed to a client (a local desktop destroy), and an id we have never seen is a peer who
 * already left — both degrade to a neutral label rather than blocking the overlay on presence.
 */
export function closedByLabel(
  by: ClientId | null,
  peers: Record<ClientId, { name: string }>
): string {
  if (by === null) return 'another user'
  return peers[by]?.name || 'another user'
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
  /**
   * DISCARD the queue and switch to pass-through, returning the number of characters dropped.
   *
   * For a redraw that supersedes everything queued: a `pty:resync` repaints the CURRENT screen
   * from tmux, so every chunk still sitting in the gate predates it — draining them would splice a
   * stale flood back on top of the fresh screen. The caller returns the dropped bytes to its flow
   * accounting (they will never reach xterm's write callback, so nothing else would).
   */
  reset(): number
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
    },
    reset() {
      const dropped = queued?.reduce((n, c) => n + c.length, 0) ?? 0
      queued = null
      return dropped
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
