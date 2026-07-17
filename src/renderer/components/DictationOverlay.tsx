// Desktop dictation overlay: record → transcribe → editable text → Send/Insert/Copy.
// A bottom-center floating card (portal to document.body, like CommandPalette/ShortcutsPanel)
// rather than a full-screen modal — see styles.css `.dictation` for the "above the Dock" placement.
//
// NOTHING here auto-submits: only the explicit Send button ever pushes text into a session.
//
// Insert (terminal): `pty.sendText(persistKey, text, { enter: false })` writes the literal text
// into the node's tmux session without the trailing Enter, so the user can edit/append before
// running it themselves (Task 10b — `enter` defaults to true everywhere else, so every other
// caller of sendText is untouched).
//
// Insert (chat): ChatNode's compose box is local component state with no externally settable
// draft, so there's no seam to write into without submitting — Insert stays disabled for chat
// targets, with a tooltip explaining why. Send (which already has an explicit-submission story)
// is the working action there.
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
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
  onClose: () => void
}

type Phase = 'idle' | 'recording' | 'transcribing' | 'text'

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

const LEVEL_POLL_MS = 100 // ~10Hz

// Base64-encoded int16 PCM runs ~2.6 MB/min. The ws bridge caps a single frame at
// WS_MAX_PAYLOAD (8 MiB, see src/server/ws.ts) — a take left running past ~3 minutes would
// produce a transcribe payload big enough to blow that budget, and `ws` drops the WHOLE
// connection on an oversized frame, not just the one message. Auto-stop well under that line.
const MAX_RECORDING_MS = 150_000 // 2:30

/** Whether elapsed recording time has crossed the hard cap (see MAX_RECORDING_MS above). Pure. */
export function isAtRecordingCap(elapsedMs: number): boolean {
  return elapsedMs >= MAX_RECORDING_MS
}

export function DictationOverlay({ target, onClose }: DictationOverlayProps) {
  const { api } = useSession()
  const addLocalUser = useChatSessions((s) => s.addLocalUser)
  const chatWorking = useChatSessions((s) =>
    target?.kind === 'chat' ? s.byId[target.nodeId]?.working : undefined
  )

  const [phase, setPhase] = useState<Phase>('idle')
  const [text, setText] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [elapsedMs, setElapsedMs] = useState(0)
  const [level, setLevel] = useState(0)
  const [sending, setSending] = useState(false)
  const [capped, setCapped] = useState(false)

  const captureRef = useRef<PcmCapture | null>(null)
  const consentAskedRef = useRef(false)
  const startedAtRef = useRef(0)
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }, [])

  // A fresh target (or the overlay reopening on the same one) starts clean — no leftover text/error
  // from a previous take.
  useEffect(() => {
    setPhase('idle')
    setText('')
    setError(null)
    setElapsedMs(0)
    setLevel(0)
    setCapped(false)
  }, [target?.nodeId])

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
      setText((prev) => appendTake(prev, transcribed))
      setPhase('text')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Transcription failed.')
      // Fall back to the text state (editable) if a prior take already produced some, else back
      // to idle so the mic button reappears.
      setPhase(text.trim() ? 'text' : 'idle')
    }
  }, [clearTimer, text])

  const startRecording = useCallback(async () => {
    setError(null)
    setCapped(false)
    if (!consentAskedRef.current) {
      consentAskedRef.current = true
      try {
        const ok = await window.nodeTerminal.speech.micConsent()
        if (!ok) {
          setError('Microphone access was not granted.')
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
    setLevel(0)
    setPhase('recording')
    timerRef.current = setInterval(() => {
      const elapsed = Date.now() - startedAtRef.current
      setElapsedMs(elapsed)
      setLevel(captureRef.current?.level() ?? 0)
      if (isAtRecordingCap(elapsed)) {
        // clearTimer() inside stopRecording fires synchronously before any await, so this can't
        // re-enter on the next tick.
        setCapped(true)
        void stopRecording()
      }
    }, LEVEL_POLL_MS)
  }, [stopRecording])

  const handleClose = useCallback(() => {
    if (phase === 'recording') {
      clearTimer()
      captureRef.current?.cancel()
      captureRef.current = null
    }
    onClose()
  }, [phase, clearTimer, onClose])

  // Esc closes (own listener, same pattern as ShortcutsPanel — only active while mounted, so it
  // never competes with Canvas's own Esc handling elsewhere).
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

  const insert = useCallback(async () => {
    if (!target || target.kind !== 'terminal') return
    const value = text.trim()
    if (!value) return
    setSending(true)
    setError(null)
    try {
      const ok = await api.pty.sendText(target.nodeId, value, { enter: false })
      if (!ok) {
        setError('Could not insert — the terminal session is not available.')
        return
      }
      onClose()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to insert.')
    } finally {
      setSending(false)
    }
  }, [target, text, api, onClose])

  // Chat has no external draft field to write into without submitting (see the header comment) —
  // Insert stays disabled there. A terminal target is always insertable once there's text.
  const insertDisabledReason = !target
    ? 'Select a terminal or chat node first.'
    : target.kind === 'chat'
      ? 'Chat has no external draft field — use Send.'
      : null

  const hasText = !!text.trim()
  const insertDisabled = !target || !hasText || sending || insertDisabledReason !== null

  return createPortal(
    <div className="dictation nodrag nowheel" onMouseDown={(e) => e.stopPropagation()}>
      <div className="dictation__head">
        <span className="dictation__title">Dictate</span>
        <span className="dictation__target">{target ? `→ ${target.title}` : 'No target selected'}</span>
        <button type="button" className="dictation__close" title="Close (Esc)" onClick={handleClose}>
          ×
        </button>
      </div>

      <div className="dictation__body">
        {phase === 'idle' && (
          <button
            type="button"
            className="dictation__mic dictation__mic--idle"
            onClick={() => void startRecording()}
            title="Start recording"
          >
            <MicIcon />
            <span>Click to record</span>
          </button>
        )}

        {phase === 'recording' && (
          <div className="dictation__recording">
            <button
              type="button"
              className="dictation__mic dictation__mic--active"
              onClick={() => void stopRecording()}
              title="Stop recording"
            >
              <MicIcon />
            </button>
            <div className="dictation__meter">
              <div className="dictation__meter-fill" style={{ width: `${Math.round(level * 100)}%` }} />
            </div>
            <span className="dictation__elapsed">{formatElapsed(elapsedMs)}</span>
          </div>
        )}

        {phase === 'transcribing' && (
          <div className="dictation__transcribing">
            <span className="dictation__spinner" />
            <span>{capped ? 'Recording capped at 2:30 — transcribing.' : 'Transcribing…'}</span>
          </div>
        )}

        {phase === 'text' && (
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
        )}
      </div>

      {error && <div className="dictation__error">{error}</div>}

      <div className="dictation__actions">
        <button type="button" className="dictation__btn" onClick={copy} disabled={!hasText}>
          Copy
        </button>
        {insertDisabledReason ? (
          <span title={insertDisabledReason}>
            <button type="button" className="dictation__btn" disabled>
              Insert
            </button>
          </span>
        ) : (
          <button
            type="button"
            className="dictation__btn"
            onClick={() => void insert()}
            disabled={insertDisabled}
          >
            Insert
          </button>
        )}
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
