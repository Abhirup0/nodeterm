// Two-act delivery of a node's one-shot launch command (initialCommand / cold-restore
// resume) into a freshly spawned shell. Writing line+Enter blind races shell init: zsh's
// rc/ZLE setup resets the tty with a FLUSH that can eat part of the queued line, and a
// mangled line submitted anyway strands the shell at `quote>` (field report: 3 spawned
// team agents, none started, each needed a manual `'` + Enter). So: write WITHOUT Enter,
// wait until the shell has echoed the tail of the line back, THEN submit. A verify timeout
// kills the pending line (Ctrl-U) and rewrites; the LAST attempt submits unverified —
// fail-open, a terminal whose echo we can't recognize must never block the launch (that
// worst case is exactly the pre-fix behavior).

export const VERIFY_TIMEOUT_MS = 2000
export const DELIVERY_ATTEMPTS = 3
/** Long enough to be unambiguous in the echo stream, short enough that a ZLE wrap/redraw
 *  sequence interleaved mid-line rarely lands inside the matched window. */
export const ECHO_TAIL_CHARS = 24
const KILL_LINE = '\x15' // Ctrl-U — clear the pending input line before a rewrite

// CSI (\x1b[...X), OSC (\x1b]...BEL|ST) and single-char ESC sequences.
// eslint-disable-next-line no-control-regex
const ESC_SEQ = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g

/** Echo stream → comparable text: drop escape sequences and line breaks (ZLE re-wraps a
 *  long line with explicit \r\n at the terminal width). */
export function cleanEcho(chunk: string): string {
  // eslint-disable-next-line no-control-regex
  return chunk.replace(ESC_SEQ, '').replace(/[\r\n]/g, '')
}

/** Has the shell echoed the full line? Tail-match: the head is polluted by the prompt. */
export function echoedIntact(cleanedSoFar: string, cmd: string): boolean {
  return cleanedSoFar.includes(cmd.slice(-ECHO_TAIL_CHARS))
}

export interface DeliveryIo {
  write(data: string): void
  /** Subscribe to session output; returns unsubscribe. */
  onData(cb: (chunk: string) => void): () => void
}

/** Deliver `cmd` + Enter, echo-verified with bounded retries. Returns a cancel function
 *  (call on node teardown). `onSettled` fires exactly once when the delivery is over — submitted
 *  (verified or fail-open) or cancelled — for callers that must know when the LINE has left the
 *  pane, not merely when it was started: the retries run for up to
 *  DELIVERY_ATTEMPTS × VERIFY_TIMEOUT_MS, and anything typed into the pane during that window
 *  lands inside the un-submitted line. */
export function deliverCommand(io: DeliveryIo, cmd: string, onSettled?: () => void): () => void {
  let done = false
  let attempt = 0
  let echoed = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsub: (() => void) | undefined

  const finish = (): void => {
    if (done) return // a cancel after the submit must not re-announce the delivery
    done = true
    if (timer) clearTimeout(timer)
    unsub?.()
    onSettled?.()
  }
  // Close the delivery BEFORE writing Enter: an io whose write echoes back synchronously (the
  // in-place restart choreography feeds one) would otherwise re-enter the listener below while
  // the tail still matches, and submit forever.
  const submit = (): void => {
    finish()
    io.write('\r')
  }
  const tryOnce = (): void => {
    if (done) return
    attempt += 1
    echoed = ''
    // Arm the verify timer BEFORE the write, for the same synchronous-echo io: an echo landing
    // inside write() finishes the delivery, and a timer armed after that would outlive it.
    timer = setTimeout(() => {
      if (done) return
      if (attempt >= DELIVERY_ATTEMPTS) {
        submit() // fail-open: unverified submit beats a never-launched agent
        return
      }
      io.write(KILL_LINE)
      tryOnce()
    }, VERIFY_TIMEOUT_MS)
    io.write(cmd)
  }

  unsub = io.onData((chunk) => {
    if (done) return
    echoed += cleanEcho(chunk)
    if (echoedIntact(echoed, cmd)) {
      if (timer) clearTimeout(timer)
      submit()
    }
  })
  tryOnce()
  return finish
}
