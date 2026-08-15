/**
 * A BOUNDED INPUT BUFFER FOR THE WAKE WINDOW — nothing the human types splices into the resume line.
 *
 * ── THE FRAGILE MOMENT THIS CLOSES ──────────────────────────────────────────────────────────────
 *
 * Waking a hibernated node re-launches its conversation with the provider's own `--resume`
 * (`agent-restart.ts` `performResumePhase`). Between the first byte of that launch line and its
 * submit there is a window — `agent-restart.ts:216` calls the un-submitted resume line *"the pane's
 * most fragile moment"* — in which anything typed is spliced INTO the command: a stray keystroke
 * turns `claude --resume <sid>` into `claude --resume <sid>x`, and the conversation is lost.
 *
 * Today there is no buffer at all: the only protections are `wakeInFlightRef` (one wake at a time)
 * and the `hibernated` re-read, neither of which touches the KEYBOARD path — `term.onData` writes
 * straight to the transport throughout the wake. cmux solved the same problem with a bounded buffer
 * (`TerminalPanel.swift:737-740`); this is that piece, pure and testable.
 *
 * ── WHAT IT DOES, AND WHICH WAY EACH EDGE FAILS ─────────────────────────────────────────────────
 *
 *  - NOT waking → `passthrough`: the caller writes the input as it always did. The buffer is inert
 *    outside a wake, so the ordinary terminal is byte-for-byte unchanged.
 *  - WAKING → `buffered`: the input is HELD, in order, and released only once the resume line is
 *    confirmed submitted (a `resumed` outcome means exactly that — `performResumePhase` resolves
 *    after the delivery settles). Held, not written: writing it now is the splice.
 *  - WAKING and OVER THE BOUND → `queueFull`: an unbounded hold is a memory-DoS on a paste or a
 *    key-repeat that never ends, so the buffer refuses past `maxChars` and holds nothing more. The
 *    refusal is LOUD (a verdict the caller can surface), never a silent drop — the same discipline
 *    the message queue applies to its own bound.
 *  - the wake ENDS resumed → `flushed`: the held input is written, in the order it arrived, into a
 *    pane whose resume line has already gone.
 *  - the wake ENDS any other way → `expired`: a wake that timed out or failed left the pane as
 *    whatever it became (a stranger's shell, a dead session), so the held bytes are DISCARDED rather
 *    than spliced into it. Dropping the buffer is the safe direction; writing it is the bug.
 *
 * `queueFull` / `expired` are named to match the message queue's outcomes on purpose: a human at a
 * waking pane and a message to a busy agent hit the same two walls (a full buffer, a lapsed wait),
 * and one vocabulary for both keeps the two features legible together.
 *
 * Pure: no DOM, no IPC, no timers. The write is injected, so the whole state machine is exercised
 * without a terminal — `wake-input-buffer.test.ts` drives every edge and mutation-checks each.
 */

/** The most keyboard input (code units) held during one wake before the buffer refuses. Small on
 *  purpose: a wake is seconds, and the only legitimate content is what a human types in that window;
 *  anything larger is a paste or a stuck key, which `queueFull` is the honest answer to. */
export const WAKE_BUFFER_MAX_CHARS = 4096

/** The verdict on one offered chunk. `passthrough` is the only one that tells the caller to write. */
export type WakeOfferVerdict =
  | { kind: 'passthrough' }
  | { kind: 'buffered'; bufferedChars: number }
  | { kind: 'queueFull'; capacity: number }

/** Why the buffer emptied: `flushed` wrote its contents, `expired` discarded them. */
export type WakeDrainReason = 'flushed' | 'expired'

export interface WakeDrainResult {
  reason: WakeDrainReason
  /** How much was held when the wake ended — for the trace, never the content itself. */
  chars: number
}

/**
 * One node's wake input buffer. Constructed per terminal node and driven by the node's wake
 * choreography: `beginWake()` when a resume starts, `offer()` on every keystroke, `endWake()` when
 * the resume resolves.
 */
export class WakeInputBuffer {
  private waking = false
  private held: string[] = []
  private chars = 0

  constructor(private readonly maxChars: number = WAKE_BUFFER_MAX_CHARS) {}

  /** A wake for this node has started — hold keyboard input from here until `endWake`. Idempotent:
   *  a second `beginWake` inside one wake (the retry path re-enters) must not drop what is held. */
  beginWake(): void {
    this.waking = true
  }

  /** Is a wake currently holding input? */
  get isWaking(): boolean {
    return this.waking
  }

  /** How much is held right now (code units). For assertions and the trace, not the content. */
  get bufferedChars(): number {
    return this.chars
  }

  /**
   * Offer one chunk of keyboard input. Returns the caller's instruction:
   *  - `passthrough` — not waking; the caller writes it to the transport as usual.
   *  - `buffered` — held; the caller writes NOTHING (writing is the splice this exists to stop).
   *  - `queueFull` — over the bound; held nothing, and the caller must not write it either. The
   *    partial chunk is refused whole rather than truncated: a half-written escape sequence is worse
   *    than a dropped one, and the caller learns the buffer is full.
   */
  offer(input: string): WakeOfferVerdict {
    if (!this.waking) return { kind: 'passthrough' }
    if (this.chars + input.length > this.maxChars) return { kind: 'queueFull', capacity: this.maxChars }
    this.held.push(input)
    this.chars += input.length
    return { kind: 'buffered', bufferedChars: this.chars }
  }

  /**
   * The wake resolved. Ends the buffering window and empties the buffer.
   *
   *  - `resumed === true`: the resume line is confirmed submitted, so the held input is written
   *    through `write`, IN ORDER, into the pane it belongs to. This is the only path that writes.
   *  - `resumed === false`: the wake did not resume the conversation (it timed out, the pane became
   *    something else, or the transport threw). The held bytes are DROPPED — splicing them into a
   *    pane we did not resume into is the failure mode this whole module exists to prevent.
   *
   * Returns what happened and how much, so the caller can trace an `expired` drain (a non-silent
   * drop, like the message queue's TTL expiry). Safe to call when not waking: it is then a no-op
   * that reports `flushed` of 0.
   */
  endWake(resumed: boolean, write: (data: string) => void): WakeDrainResult {
    const held = this.held
    const chars = this.chars
    this.held = []
    this.chars = 0
    this.waking = false
    if (resumed) {
      for (const chunk of held) write(chunk)
      return { reason: 'flushed', chars }
    }
    return { reason: 'expired', chars }
  }
}
