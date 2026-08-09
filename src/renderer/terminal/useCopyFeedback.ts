// Glue between the two signals a terminal already produces and the header pill: the drag
// (mousedown/mouseup on the xterm host) and the OSC 52 arrival (the clipboard-write handler).
// The decisions live in ./copy-feedback; this file owns the listeners, the timers, the one-time
// storage flag, and the browser-honesty rule.
import { useCallback, useEffect, useRef, useState } from 'react'
import { isMacPlatform } from '@shared/platform-utils'
import {
  COPIED_DWELL_MS,
  HINT_DWELL_MS,
  HINT_STORAGE_KEY,
  OSC52_GRACE_MS,
  copiedLabel,
  decideDragOutcome,
  type CopyFeedback
} from './copy-feedback'

/** Guarded both ways: this module is imported by node-environment vitest suites, and a browser
 *  with storage disabled must not break copying. */
function hintSeen(): boolean {
  try {
    if (typeof localStorage === 'undefined') return true
    return localStorage.getItem(HINT_STORAGE_KEY) === '1'
  } catch {
    return true
  }
}

function markHintSeen(): void {
  try {
    if (typeof localStorage !== 'undefined') localStorage.setItem(HINT_STORAGE_KEY, '1')
  } catch {
    // A hint we cannot remember is better shown once too often than not at all — but never fatal.
  }
}

export interface CopyFeedbackApi {
  /** What the pill shows right now, or null. */
  feedback: CopyFeedback
  /** Call from THIS terminal's OSC 52 handler once the clipboard was written. Stable identity. */
  notifyCopy: (text: string) => void
}

export function useCopyFeedback(opts: {
  /** The element xterm was `open()`ed into. */
  hostRef: React.RefObject<HTMLElement | null>
  /** Does xterm hold a selection of its own right now? (⌥/Shift drag.) */
  hasSelection: () => boolean
}): CopyFeedbackApi {
  const { hostRef } = opts
  const [feedback, setFeedback] = useState<CopyFeedback>(null)
  const dwellTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const decideTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  /** When the last clipboard write landed — read by the drag decision. */
  const lastCopyAt = useRef(0)
  // Read through a ref so the listener effect never re-runs when the caller passes a fresh closure.
  const hasSelectionRef = useRef(opts.hasSelection)
  hasSelectionRef.current = opts.hasSelection

  const show = useCallback((next: CopyFeedback, dwellMs: number): void => {
    if (dwellTimer.current) clearTimeout(dwellTimer.current)
    setFeedback(next)
    dwellTimer.current = setTimeout(() => setFeedback(null), dwellMs)
  }, [])

  const notifyCopy = useCallback(
    (text: string): void => {
      lastCopyAt.current = Date.now()
      const label = copiedLabel(text)
      if (label) show({ kind: 'copied', label }, COPIED_DWELL_MS)
    },
    [show]
  )

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    let downAt: { x: number; y: number; t: number } | null = null
    const onDown = (e: MouseEvent): void => {
      if (e.button !== 0) return
      downAt = { x: e.clientX, y: e.clientY, t: Date.now() }
    }
    const onUp = (e: MouseEvent): void => {
      const from = downAt
      downAt = null
      if (!from || e.button !== 0) return
      const movedPx = Math.hypot(e.clientX - from.x, e.clientY - from.y)
      // tmux copies on RELEASE, so the OSC 52 is still in flight right now — decide after the
      // grace window, comparing against the moment the gesture STARTED (an earlier, unrelated
      // copy must not silence this drag's hint).
      if (decideTimer.current) clearTimeout(decideTimer.current)
      decideTimer.current = setTimeout(() => {
        const out = decideDragOutcome({
          movedPx,
          sawOsc52: lastCopyAt.current >= from.t,
          hasXtermSelection: hasSelectionRef.current(),
          hintSeen: hintSeen(),
          isMac: isMacPlatform()
        })
        if (!out) return
        markHintSeen()
        show(out, HINT_DWELL_MS)
      }, OSC52_GRACE_MS)
    }
    host.addEventListener('mousedown', onDown)
    // mouseup on the WINDOW: a selection drag very often ends outside the terminal box (the user
    // overshoots the node), and that gesture still ended.
    window.addEventListener('mouseup', onUp)
    return () => {
      host.removeEventListener('mousedown', onDown)
      window.removeEventListener('mouseup', onUp)
    }
  }, [hostRef, show])

  // Browser honesty: on the Server Edition `clipboard.writeText` can fail (a non-secure context),
  // and the stub already raises a `nodeterm:toast` error banner. A green "Copied" pill beside that
  // banner would contradict it, so the pill yields — the banner keeps the truth.
  useEffect(() => {
    const onToast = (e: Event): void => {
      const detail = (e as CustomEvent<{ kind?: string }>).detail
      if (detail?.kind !== 'error') return
      setFeedback((cur) => (cur?.kind === 'copied' ? null : cur))
    }
    window.addEventListener('nodeterm:toast', onToast)
    return () => window.removeEventListener('nodeterm:toast', onToast)
  }, [])

  useEffect(
    () => () => {
      if (dwellTimer.current) clearTimeout(dwellTimer.current)
      if (decideTimer.current) clearTimeout(decideTimer.current)
    },
    []
  )

  return { feedback, notifyCopy }
}
