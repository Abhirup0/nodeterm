// Desktop press-to-talk: shortcut/Dock-mic press starts recording IMMEDIATELY into a compact
// bottom-center pill (stop icon + live equalizer + elapsed mm:ss); pressing again (or the pill's
// own stop icon) stops → transcribes → for a terminal target inserts the text directly
// (`pty.sendText(id, text, { enter: false })`, no Enter — nothing here ever auto-submits) and the
// pill closes; for a chat target (no external draft field to insert into) the transcript opens
// in the v1 editable CARD instead, where the user still presses Send themselves.
//
// Two different ways to dismiss, not interchangeable:
//  - STOP (shortcut second-press / the pill's stop icon) — ends the recording and PROCESSES it
//    (transcribe → insert/card).
//  - CANCEL (Esc, or the ×/close affordances) — DISCARDS whatever was being recorded and closes
//    the whole overlay. Esc mid-recording is cancel, not stop, even though both are triggered by
//    a "press" — see handleClose vs the stopSignal branch below.
//
// No target selected at press time never records at all — see the warning-pill render branch.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { equalizerBars } from '../lib/dictation-equalizer'
import { PcmCapture } from '../lib/pcm-capture'
import { useSession } from '../session/session'
import { useChatSessions } from '../state/chatSessions'

export interface DictationTarget {
  kind: 'terminal' | 'chat'
  nodeId: string
  title: string
}

interface DictationOverlayProps {
  target: DictationTarget | null
  /** Bumped by Canvas's toggleDictation on a second shortcut/Dock-mic press while the overlay is
   *  already open. A no-op prop change is the signal (any new value ≠ close-then-reopen — the
   *  overlay itself decides what a "press again" means from its own current phase: STOP while
   *  recording, CANCEL/close otherwise). */
  stopSignal: number
  onClose: () => void
  /** Routes to Settings → License (same section SpeechSection's own Pro upsells use) — invoked
   *  from the "See nodeterm Pro" action shown beside a Pro-model transcribe error. */
  onOpenLicense: () => void
}

/** A Pro-gated model was picked but the account isn't premium — see SpeechService.transcribeNow,
 *  which throws exactly this shape. Matched by substring since the model id is interpolated in. */
export function isProGateError(message: string): boolean {
  return message.includes('requires nodeterm Pro')
}

type Phase = 'idle' | 'recording' | 'transcribing' | 'text'
/** 'warning' = no target at press time (never records). 'pill' = the compact recording/
 *  transcribing/error capsule — used for BOTH targets while a take is in flight, and for a
 *  terminal target start to finish (it never reaches 'card'). 'card' = the v1 editable text
 *  card, reached only once a chat target's take has transcribed successfully (and again if the
 *  user re-records another take from there — the re-record trip goes back out through 'pill'). */
export type DictationMode = 'warning' | 'pill' | 'card'

/** Pure — no side effects. Exported for its own unit coverage. */
export function dictationMode(target: DictationTarget | null, phase: Phase): DictationMode {
  if (!target) return 'warning'
  if (target.kind === 'chat' && phase === 'text') return 'card'
  return 'pill'
}

/** mm:ss, floored to whole seconds. Pure — no side effects. */
export function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

/** Appends a new take's text after any existing text, space-separated; trims both sides. */
export function appendTake(existing: string, take: string): string {
  const a = existing.trim()
  const b = take.trim()
  if (!a) return b
  if (!b) return a
  return `${a} ${b}`
}

// Faster than the visual 12-bar window needs on its own — the point is to feed more DISTINCT
// samples into that scrolling window (see dictation-equalizer.ts) so the equalizer reads as live
// motion instead of a slow crawl. PcmCapture.level() (RMS of the last chunk) is cheap enough that
// polling twice as often here has no measurable cost.
const LEVEL_POLL_MS = 50 // ~20Hz

// Base64-encoded int16 PCM runs ~2.6 MB/min. The ws bridge caps a single frame at
// WS_MAX_PAYLOAD (8 MiB, see src/server/ws.ts) — a take left running past ~3 minutes would
// produce a transcribe payload big enough to blow that budget, and `ws` drops the WHOLE
// connection on an oversized frame, not just the one message. Auto-stop well under that line.
const MAX_RECORDING_MS = 150_000 // 2:30

/** Whether elapsed recording time has crossed the hard cap (see MAX_RECORDING_MS above). Pure. */
export function isAtRecordingCap(elapsedMs: number): boolean {
  return elapsedMs >= MAX_RECORDING_MS
}

/** How long the "no target selected" warning pill stays up before it auto-dismisses. */
const NO_TARGET_DISMISS_MS = 2500

export function DictationOverlay({ target, stopSignal, onClose, onOpenLicense }: DictationOverlayProps) {
  const { api } = useSession()
  const addLocalUser = useChatSessions((s) => s.addLocalUser)
  const chatWorking = useChatSessions((s) =>
    target?.kind === 'chat' ? s.byId[target.nodeId]?.working : undefined
  )

  const [phase, setPhase] = useState<Phase>('idle')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [levelHistory, setLevelHistory] = useState<number[]>([])
  const [sending, setSending] = useState(false)
  const [capped, setCapped] = useState(false)

  const captureRef = useRef<PcmCapture | null>(null)
  const consentAskedRef = useRef(false)
  const startedAtRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)
  const discardedRef = useRef(false)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // Belt-and-braces: if this component unmounts mid-recording (parent flips `open` without going
  // through handleClose — e.g. a project switch), the mic must not stay live.
  useEffect(() => {
    return () => {
      clearTimer()
      captureRef.current?.cancel()
      captureRef.current = null
    }
  }, [clearTimer])

  const stopRecording = useCallback(async () => {
    clearTimer()
    const capture = captureRef.current
    captureRef.current = null
    if (!capture) return
    const pcm = capture.stop()
    setPhase('transcribing')
    try {
      const { text: transcribed } = await window.nodeTerminal.speech.transcribe(pcm)
      if (!target) {
        // Defensive only — recording never starts without a target (see the mount effect below).
        onClose()
        return
      }
      // An in-flight transcription can't be aborted — dropping the result honors the user's
      // dismissal (nothing may land after a cancel).
      if (discardedRef.current) return
      if (target.kind === 'terminal') {
        const ok = await api.pty.sendText(target.nodeId, transcribed, { enter: false })
        if (!ok) {
          setError('Could not insert — the terminal session is not available.')
          setPhase('idle')
          return
        }
        onClose()
        return
      }
      // Chat: no external draft field to insert into (see the file header) — open the editable
      // card so the user can review/edit and press Send themselves. Appends onto any earlier take
      // (re-record from the card).
      setText((prev) => appendTake(prev, transcribed))
      setPhase('text')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transcription failed.')
      // A chat target with an earlier successful take falls back to the card (keeping that text,
      // now alongside the error); everything else (terminal, or no prior text yet) falls back to
      // the pill so the user can retry.
      setPhase(text.trim() ? 'text' : 'idle')
    }
  }, [clearTimer, target, api, onClose, text])

  const startRecording = useCallback(async () => {
    if (!target) return
    setError(null)
    setCapped(false)
    if (!consentAskedRef.current) {
      consentAskedRef.current = true
      try {
        const ok = await window.nodeTerminal.speech.micConsent()
        if (!ok) {
          setError(
            'Microphone access was not granted — allow it in System Settings (or your browser site settings) and try again.'
          )
          return
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not request microphone access.')
        return
      }
    }

    const capture = new PcmCapture()
    try {
      await capture.start()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not start recording.')
      return
    }
    captureRef.current = capture

    startedAtRef.current = Date.now()
    setElapsedMs(0)
    setLevelHistory([])
    setPhase('recording')
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current
      setElapsedMs(elapsed)
      const level = captureRef.current?.level() ?? 0
      setLevelHistory((prev) => [...prev, level])
      if (isAtRecordingCap(elapsed)) {
        // clearTimer() inside stopRecording fires synchronously before any await, so this can't
        // re-enter on the next tick.
        setCapped(true)
        void stopRecording()
      }
    }, LEVEL_POLL_MS)
  }, [target, stopRecording])

  // Press-to-talk: a target means "start recording now" (this instance is a fresh mount each
  // time Canvas opens the overlay, and the target is frozen for its lifetime — see
  // DictationOverlayProps — so this is correctly mount-only). No target means the warning pill;
  // it never records, and auto-dismisses on its own.
  useEffect(() => {
    if (!target) {
      const t = setTimeout(() => onCloseRef.current(), NO_TARGET_DISMISS_MS)
      return () => clearTimeout(t)
    }
    void startRecording()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const handleClose = useCallback(() => {
    discardedRef.current = true
    if (phase === 'recording') {
      clearTimer()
      captureRef.current?.cancel()
      captureRef.current = null
    }
    onClose()
  }, [phase, clearTimer, onClose])

  // Esc closes (own listener, same pattern as ShortcutsPanel — only active while mounted, so it
  // never competes with Canvas's own Esc handling elsewhere). This is CANCEL, not stop — see the
  // file header.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        handleClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [handleClose])

  // A second shortcut/Dock-mic press while this overlay is already open (Canvas bumps
  // `stopSignal` rather than unmounting us — see DictationOverlayProps). While actively
  // recording that means STOP (transcribe → insert/card); in every other phase (warning,
  // transcribing, the editable card, an error pill) it means dismiss, same as Esc/×.
  const prevStopSignalRef = useRef(stopSignal)
  useEffect(() => {
    if (stopSignal === prevStopSignalRef.current) return
    prevStopSignalRef.current = stopSignal
    if (phase === 'recording') {
      void stopRecording()
    } else {
      handleClose()
    }
  }, [stopSignal, phase, stopRecording, handleClose])

  const send = useCallback(async () => {
    if (!target) return
    const value = text.trim()
    if (!value) return
    setSending(true)
    setError(null)
    try {
      if (target.kind === 'terminal') {
        const ok = await api.pty.sendText(target.nodeId, value)
        if (!ok) {
          setError('Could not send — the terminal session is not available.')
          return
        }
      } else {
        api.chat.send(target.nodeId, value)
        if (!chatWorking) addLocalUser(target.nodeId, value)
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to send.')
    } finally {
      setSending(false)
    }
  }, [target, text, api, chatWorking, addLocalUser, onClose])

  const copy = useCallback(() => {
    const value = text.trim()
    if (!value) return
    window.nodeTerminal.clipboard.writeText(value)
  }, [text])

  const hasText = !!text.trim()
  const mode = dictationMode(target, phase)

  const errorBlock = error && (
    <div className="dictation__error">
      <span>{error}</span>
      {isProGateError(error) && (
        <button type="button" className="dictation__error-action" onClick={onOpenLicense}>
          See nodeterm Pro
        </button>
      )}
      <button type="button" className="dictation__close" title="Dismiss" onClick={handleClose}>
        ×
      </button>
    </div>
  )

  if (mode === 'warning') {
    return createPortal(
      <div className="dictation dictation--warning nodrag nowheel" onMouseDown={(e) => e.stopPropagation()}>
        <span className="dictation__warning-text">Select a terminal or chat node first.</span>
        <button type="button" className="dictation__close" title="Dismiss" onClick={handleClose}>
          ×
        </button>
      </div>,
      document.body
    )
  }

  if (mode === 'pill') {
    return createPortal(
      <div className="dictation dictation--pill nodrag nowheel" onMouseDown={(e) => e.stopPropagation()}>
        {phase === 'recording' && (
          <div className="dictation__pill">
            <button
              type="button"
              className="dictation__stop"
              onClick={() => void stopRecording()}
              title="Stop recording — transcribes & inserts"
            >
              <StopIcon />
            </button>
            <div className="dictation__bars" aria-hidden="true">
              {equalizerBars(levelHistory).map((h, i) => (
                <span key={i} className="dictation__bar" style={{ height: `${Math.round(h * 100)}%` }} />
              ))}
            </div>
            <span className="dictation__elapsed">{formatElapsed(elapsedMs)}</span>
          </div>
        )}

        {phase === 'transcribing' && (
          <div className="dictation__transcribing">
            <span className="dictation__spinner" />
            <span>{capped ? 'Recording capped at 2:30 — transcribing…' : 'Transcribing…'}</span>
          </div>
        )}

        {phase === 'idle' && !error && (
          <div className="dictation__transcribing">
            <span className="dictation__spinner" />
            <span>Starting…</span>
          </div>
        )}

        {errorBlock}
      </div>,
      document.body
    )
  }

  // mode === 'card' — chat only, reached once a take has transcribed. v1 editable card, minus
  // Insert (chat has no external draft field — see the file header; the quick pill flow above is
  // how a terminal target ever gets text inserted, so Insert has no reachable case here at all).
  return createPortal(
    <div className="dictation dictation--card nodrag nowheel" onMouseDown={(e) => e.stopPropagation()}>
      <div className="dictation__head">
        <span className="dictation__title">Dictate</span>
        <span className="dictation__target">→ {target?.title}</span>
        <button type="button" className="dictation__close" title="Close (Esc)" onClick={handleClose}>
          ×
        </button>
      </div>

      <div className="dictation__body">
        <div className="dictation__text-row">
          <textarea
            className="dictation__textarea"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Transcribed text…"
            autoFocus
            spellCheck
          />
          <button
            type="button"
            className="dictation__mic dictation__mic--small"
            onClick={() => void startRecording()}
            title="Record another take (appends)"
          >
            <MicIcon />
          </button>
        </div>
      </div>

      {errorBlock}

      <div className="dictation__actions">
        <button type="button" className="dictation__btn" onClick={copy} disabled={!hasText}>
          Copy
        </button>
        <button
          type="button"
          className="dictation__btn dictation__btn--primary"
          onClick={() => void send()}
          disabled={!target || !hasText || sending}
        >
          Send
        </button>
      </div>
    </div>,
    document.body
  )
}

function MicIcon() {
  return (
    <svg width={18} height={18} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round">
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v4M8 22h8" />
    </svg>
  )
}

function StopIcon() {
  return (
    <svg width={14} height={14} viewBox="0 0 24 24" fill="currentColor">
      <rect x="5" y="5" width="14" height="14" rx="2" />
    </svg>
  )
}
