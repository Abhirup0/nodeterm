import { useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ViewportPortal, useReactFlow } from '@xyflow/react'
import { CHAT_MAX_LEN } from '@shared/presence'
import { selectVisible, usePresence } from '../state/presence'
import { useProjects } from '../state/projects'
import { CURSOR_MIN_INTERVAL_MS, canOpenCursorChat, type KeyTarget } from '../lib/presenceKeys'

// A sent chat line lingers this long after Enter, then clears itself.
const CHAT_LINGER_MS = 5000

/**
 * Live cursors, name labels and cursor-chat bubbles for every other peer ON THIS PROJECT, plus
 * the local cursor sampler and the "/" cursor-chat input.
 *
 * PROJECT SCOPE: a project is its own canvas with its own nodes and its own flow coordinate
 * space, so only peers whose `projectId` matches the active project are drawn — a teammate on
 * another tab would otherwise have their cursor painted here at meaningless coordinates.
 * Off-project peers live in the Facepile instead.
 *
 * PERF: this is the only component subscribed to cursor traffic (see state/presence.ts). The
 * sampler is a single rAF loop throttled to ~20 Hz that runs ONLY while another peer shares this
 * canvas — alone, this component renders null and installs no listeners. Smoothing between the
 * 20 Hz updates is a CSS transition on `transform`, not a JS lerp loop.
 */
export function PresenceLayer(): JSX.Element | null {
  const activeProjectId = useProjects((s) => s.activeProjectId)
  // Hard project filter — not a style: an off-project peer is not rendered at all.
  // useShallow: the selector derives a NEW array each call, and zustand's default Object.is
  // equality would make React 18's useSyncExternalStore complain (and re-render on every store
  // write). Shallow-compare the array instead.
  const others = usePresence(useShallow((s) => selectVisible(s, activeProjectId || null)))
  const hasOthers = others.length > 0
  const { screenToFlowPosition } = useReactFlow()

  // Cursor-chat input (local). `null` = closed.
  const [chat, setChat] = useState<string | null>(null)
  // Where to anchor the local chat input on screen (client coords of the last pointer position).
  const screenRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const lingerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // ---- local cursor sampling (rAF + ~20 Hz), only while someone else is here ----
  useEffect(() => {
    if (!hasOthers) return
    let raf = 0
    let last = 0
    let pending: { x: number; y: number } | null = null

    const onPointerMove = (e: PointerEvent): void => {
      pending = { x: e.clientX, y: e.clientY }
      screenRef.current = pending
    }
    const onPointerLeave = (): void => {
      pending = null
      window.nodeTerminal.presence.cursor(null)
    }
    const tick = (): void => {
      raf = requestAnimationFrame(tick)
      if (!pending) return
      const now = performance.now()
      if (now - last < CURSOR_MIN_INTERVAL_MS) return
      last = now
      const p = pending
      pending = null
      const flow = screenToFlowPosition({ x: p.x, y: p.y })
      window.nodeTerminal.presence.cursor({ x: Math.round(flow.x), y: Math.round(flow.y) })
    }

    window.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerleave', onPointerLeave)
    raf = requestAnimationFrame(tick)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerleave', onPointerLeave)
      cancelAnimationFrame(raf)
      window.nodeTerminal.presence.cursor(null)
    }
  }, [hasOthers, screenToFlowPosition])

  // ---- "/" opens cursor chat (never while typing in xterm / Monaco / an input) ----
  useEffect(() => {
    if (!hasOthers) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      if (chat !== null) return
      if (!canOpenCursorChat(document.activeElement as unknown as KeyTarget | null)) return
      e.preventDefault()
      if (lingerRef.current) clearTimeout(lingerRef.current)
      setChat('')
      window.nodeTerminal.presence.chat('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasOthers, chat])

  useEffect(
    () => () => {
      if (lingerRef.current) clearTimeout(lingerRef.current)
    },
    []
  )

  if (!hasOthers) return null

  const closeChat = (linger: boolean): void => {
    setChat(null)
    if (lingerRef.current) clearTimeout(lingerRef.current)
    if (linger) {
      // Enter: the bubble stays up for the readers, then clears itself.
      lingerRef.current = setTimeout(() => window.nodeTerminal.presence.chat(null), CHAT_LINGER_MS)
    } else {
      window.nodeTerminal.presence.chat(null)
    }
  }

  return (
    <>
      <ViewportPortal>
        {others.map((p) =>
          p.cursor ? (
            <div
              key={p.clientId}
              className="presence-cursor"
              style={{ transform: `translate(${p.cursor.x}px, ${p.cursor.y}px)`, color: p.color }}
            >
              <svg className="presence-cursor__arrow" width="18" height="18" viewBox="0 0 18 18">
                <path
                  d="M2 2 L2 14 L5.5 10.6 L8 15.6 L10.4 14.4 L7.9 9.5 L12.6 9.5 Z"
                  fill="currentColor"
                  stroke="#000"
                  strokeWidth="0.75"
                />
              </svg>
              <span className="presence-cursor__name" style={{ background: p.color }}>
                {p.name}
              </span>
              {p.chat ? <span className="presence-cursor__chat">{p.chat}</span> : null}
            </div>
          ) : null
        )}
      </ViewportPortal>

      {chat !== null && (
        <input
          className="presence-chat-input nodrag nowheel"
          autoFocus
          value={chat}
          maxLength={CHAT_MAX_LEN}
          placeholder="Say something…"
          style={{ left: screenRef.current.x + 16, top: screenRef.current.y + 16 }}
          onChange={(e) => {
            setChat(e.target.value)
            window.nodeTerminal.presence.chat(e.target.value)
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              closeChat(true)
            } else if (e.key === 'Escape') {
              e.preventDefault()
              closeChat(false)
            }
            e.stopPropagation() // never let canvas shortcuts see the typing
          }}
          onBlur={() => closeChat(false)}
        />
      )}
    </>
  )
}

export default PresenceLayer
