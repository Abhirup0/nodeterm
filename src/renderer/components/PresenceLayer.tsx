import { useCallback, useEffect, useRef, useState } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { ViewportPortal, useReactFlow, useStore } from '@xyflow/react'
import { CHAT_MAX_LEN } from '@shared/presence'
import { useProjects } from '../state/projects'
import { useActiveSessionApi, useActiveSessionPresence } from '../session/session'
import {
  CHAT_ANCHOR_OFFSET_PX,
  CURSOR_HOTSPOT_PX,
  CURSOR_MIN_INTERVAL_MS,
  canOpenCursorChat,
  counterScale,
  type KeyTarget
} from '../lib/presenceKeys'

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
 * canvas AND the local pointer is actually moving (it stops itself when nothing is pending and the
 * pointer-move handler restarts it) — alone, this component renders null and installs no
 * listeners. Smoothing between the 20 Hz updates is a CSS transition on `transform`, not a JS lerp
 * loop. Zoom is read via React Flow's own store, so a zoom tick re-renders THIS layer only, never
 * Canvas.
 */
export function PresenceLayer(): JSX.Element | null {
  // The ACTIVE session's core API — where cursor/chat casts go — and its presence store, both
  // resolved provider-independently (reactive on the active project) so they always agree on the
  // session. Stable per active session, and both are listed in the effect/callback deps below, so
  // a tab switch that changes the active session rebinds the rAF sampler and effect cleanups.
  const api = useActiveSessionApi()
  const presence = useActiveSessionPresence()
  const activeProjectId = useProjects((s) => s.activeProjectId)
  // Hard project filter — not a style: an off-project peer is not rendered at all.
  // useShallow: the selector derives a NEW array each call, and zustand's default Object.is
  // equality would make React 18's useSyncExternalStore complain (and re-render on every store
  // write). Shallow-compare the array instead.
  const others = presence.store(useShallow((s) => presence.selectVisible(s, activeProjectId || null)))
  const hasOthers = others.length > 0
  const { screenToFlowPosition } = useReactFlow()
  // Live viewport zoom, straight from React Flow's store: this subscribes THIS component, so a
  // zoom tick re-renders the cursor layer (cheap) and leaves Canvas.tsx untouched.
  const zoom = useStore((s) => s.transform[2])

  // Cursor-chat input (local). `null` = closed.
  const [chat, setChat] = useState<string | null>(null)
  // Where the input is pinned on screen: a SNAPSHOT of the pointer taken when the chat opened, not
  // the live pointer. Read during render, so it must be state — reading the live pointer ref here
  // would make the "anchor" chase the mouse whenever a peer's cursor happened to re-render us.
  const [anchor, setAnchor] = useState<{ x: number; y: number } | null>(null)
  // The last pointer position (client coords), updated at pointer rate. Never read during render.
  const screenRef = useRef<{ x: number; y: number }>({ x: 0, y: 0 })
  const lingerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // True while peers are showing a chat line of ours that we have not retracted yet — so we know
  // whether a `chat(null)` is owed (on close, on the last peer leaving, on unmount).
  const publishedRef = useRef(false)

  // This flag claims what our PEERS can see, so it must never over-claim a retraction. The hub
  // rate-limits `presence:chat` (one cast per keystroke, and a held key repeats far faster than
  // anyone types), and it drops silently — but a `chat(null)` is EXEMPT from that bucket
  // (src/core/presence/hub.ts, isClearingCast), precisely so that clearing publishedRef here is
  // not a lie. Without the exemption a keyup retraction landing on a drained bucket would leave a
  // chat bubble pinned to our cursor on every peer's canvas, forever: we would already believe we
  // had retracted it, and nothing re-announces.
  // The other direction is safe by construction: a DROPPED non-null cast still sets the flag, so
  // at worst we retract something no peer saw — and the hub ignores an unchanged value.
  const sendChat = useCallback((text: string | null): void => {
    if (text === null && !publishedRef.current) return // nothing to retract — don't spam the wire
    publishedRef.current = text !== null
    api.presence.chat(text)
  }, [api])

  /** Close the input and drop the local state. `linger`: keep the bubble up for the readers for a
   *  few seconds (Enter), then retract it. Safe to call when nothing is open. */
  const closeChat = useCallback(
    (linger: boolean): void => {
      setChat(null)
      setAnchor(null)
      if (lingerRef.current) {
        clearTimeout(lingerRef.current)
        lingerRef.current = null
      }
      if (linger && publishedRef.current) {
        lingerRef.current = setTimeout(() => {
          lingerRef.current = null
          sendChat(null)
        }, CHAT_LINGER_MS)
      } else {
        sendChat(null)
      }
    },
    [sendChat]
  )

  // ---- local cursor sampling (rAF + ~20 Hz), only while someone else is here ----
  useEffect(() => {
    if (!hasOthers) return
    let raf = 0
    let last = 0
    let pending: { x: number; y: number } | null = null

    // The loop runs ONLY while a sample is pending: it stops itself when the pointer goes still
    // (an idle canvas must not burn a 60 Hz rAF forever) and onPointerMove restarts it.
    const schedule = (): void => {
      if (!raf) raf = requestAnimationFrame(tick)
    }
    const tick = (): void => {
      raf = 0
      if (!pending) return // idle — the next pointermove will restart the loop
      const now = performance.now()
      if (now - last < CURSOR_MIN_INTERVAL_MS) {
        schedule() // throttled: come back next frame, the sample is still pending
        return
      }
      last = now
      const p = pending
      pending = null
      const flow = screenToFlowPosition({ x: p.x, y: p.y })
      api.presence.cursor({ x: Math.round(flow.x), y: Math.round(flow.y) })
    }

    const onPointerMove = (e: PointerEvent): void => {
      pending = { x: e.clientX, y: e.clientY }
      screenRef.current = pending
      schedule()
    }
    const onPointerLeave = (): void => {
      pending = null
      api.presence.cursor(null)
    }

    window.addEventListener('pointermove', onPointerMove)
    document.addEventListener('pointerleave', onPointerLeave)
    return () => {
      window.removeEventListener('pointermove', onPointerMove)
      document.removeEventListener('pointerleave', onPointerLeave)
      if (raf) cancelAnimationFrame(raf)
      api.presence.cursor(null)
    }
  }, [hasOthers, screenToFlowPosition, api])

  // ---- "/" opens cursor chat (never while typing in xterm / Monaco / an input) ----
  useEffect(() => {
    if (!hasOthers) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return
      if (chat !== null) return
      if (!canOpenCursorChat(document.activeElement as unknown as KeyTarget | null)) return
      e.preventDefault()
      if (lingerRef.current) {
        clearTimeout(lingerRef.current)
        lingerRef.current = null
      }
      // Snapshot the pointer NOW: the input is anchored where you opened it and stays there.
      setAnchor({ ...screenRef.current })
      setChat('')
      sendChat('')
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [hasOthers, chat, sendChat])

  // The last peer left: below, this component renders null, so an open chat would become an
  // INVISIBLE open chat — "/" would keep early-returning, the hub would keep our last line, and a
  // peer joining later would re-mount the input (autoFocus!) with stale text. Close it for real.
  useEffect(() => {
    if (!hasOthers) closeChat(false)
  }, [hasOthers, closeChat])

  // Unmount: retract whatever peers can still see (an open input, or a lingering sent line) —
  // the mirror of the sampler's cursor(null).
  useEffect(
    () => () => {
      if (lingerRef.current) clearTimeout(lingerRef.current)
      if (publishedRef.current) api.presence.chat(null)
    },
    [api]
  )

  if (!hasOthers) return null

  // Cursors are positioned in FLOW space (inside the viewport transform) but sized in SCREEN
  // space: the counter-scale cancels the zoom, pivoting on the arrow tip.
  const scale = counterScale(zoom)
  const hotspot = `${CURSOR_HOTSPOT_PX}px ${CURSOR_HOTSPOT_PX}px`

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
              <div
                className="presence-cursor__scale"
                style={{ transform: scale, transformOrigin: hotspot }}
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
            </div>
          ) : null
        )}
      </ViewportPortal>

      {chat !== null && anchor && (
        <input
          className="presence-chat-input nodrag nowheel"
          autoFocus
          value={chat}
          maxLength={CHAT_MAX_LEN}
          placeholder="Say something…"
          style={{ left: anchor.x + CHAT_ANCHOR_OFFSET_PX, top: anchor.y + CHAT_ANCHOR_OFFSET_PX }}
          onChange={(e) => {
            setChat(e.target.value)
            sendChat(e.target.value)
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
