// Detects whether a Claude Code session is actively working, from its terminal output.
//
// Signals (layered, so it works regardless of which ones a given Claude build emits):
//  - PRIMARY: the working line Claude redraws each frame while a turn runs — it contains
//    "esc to interrupt" plus a spinner glyph. While that keeps appearing we stay "busy".
//  - COMPLETION: when the working line stops appearing for IDLE_MS, we flip to idle. A
//    terminal bell (if Claude rings one on turn end) shortens that wait.
// We test the raw chunk: "esc to interrupt" is contiguous ASCII (ANSI color codes wrap the
// whole line, not the phrase), so no escape-sequence stripping is needed. If Claude changes
// its UI wording, update WORKING below — it's the single source of truth.

const WORKING =
  /esc to interrupt|[✶✻✽✺✳✢⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]\s|\b(?:Working|Thinking|Forging|Cogitating|Pondering|Brewing|Herding|Simmering|Spelunking|Reticulating)…?/i

const IDLE_MS = 1500
const BELL_IDLE_MS = 400

export interface ClaudeBusyDetector {
  /** Feed a raw output chunk. */
  feed(chunk: string): void
  /** Call when the terminal bell fires. */
  bell(): void
  dispose(): void
}

export function createClaudeBusyDetector(
  onChange: (busy: boolean) => void
): ClaudeBusyDetector {
  let busy = false
  let idleTimer: ReturnType<typeof setTimeout> | null = null

  const setBusy = (b: boolean) => {
    if (b === busy) return
    busy = b
    onChange(b)
  }

  const armIdle = (ms = IDLE_MS) => {
    if (idleTimer) clearTimeout(idleTimer)
    idleTimer = setTimeout(() => setBusy(false), ms)
  }

  return {
    feed(chunk) {
      if (WORKING.test(chunk)) {
        setBusy(true)
        armIdle()
      }
    },
    bell() {
      // A bell usually marks the end of a turn; flip to idle soon (unless work resumes).
      if (busy) armIdle(BELL_IDLE_MS)
    },
    dispose() {
      if (idleTimer) clearTimeout(idleTimer)
      idleTimer = null
    }
  }
}
