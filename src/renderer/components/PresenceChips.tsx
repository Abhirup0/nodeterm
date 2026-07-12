import type { CSSProperties } from 'react'
import { useShallow } from 'zustand/react/shallow'
import { selectFocusedFaces, selectTypingFaces, usePresence } from '../state/presence'
import { useProjects } from '../state/projects'
import { chipStrip } from '../lib/presenceChips'

/**
 * Avatar chips for the peers focused on ONE node OF THIS PROJECT, drawn in its header beside the
 * agent badge: "who else is in this terminal". Everyone beyond the cap collapses into a "+N" bubble
 * (see lib/presenceChips.ts); the facepile is where you go to see the whole room.
 *
 * PROJECT SCOPE: node ids are globally unique, so a peer focused on a node in ANOTHER project would
 * otherwise chip the same-id node here. selectFocusedFaces takes the active project id and filters
 * on it (via selectVisible) — the same single filter the cursors go through. No hand-filtering.
 *
 * TYPING (co-attach): a chip PULSES while that peer's keystrokes are landing in THIS terminal. One
 * PTY, N subscribers and no locking, so two people typing into one shell interleave their characters
 * — the ring is the warning. It is fed by a SECOND selector, deliberately NOT project-filtered (a
 * phone has no canvas, so the focus list excludes it, yet it can be typing right here) — see
 * selectTypingFaces — and a typist who is not focused here is chipped anyway (lib/presenceChips.ts).
 *
 * PERF: THIS component subscribes to the presence store, not TerminalNode — and it subscribes to
 * FACES, not PeerStates. A cursor patch rebuilds a peer's PeerState object ~20×/s, so a PeerState
 * selector would re-render every terminal node on the canvas at cursor rate; faces are the same
 * objects until a name/color/project/kind actually changes, so `useShallow` bails out and a moving
 * cursor re-renders nothing here. The typing selector keeps that property: a cursor patch does not
 * touch the typing marks, so it returns the very same (usually empty and shared) array.
 */
export function PresenceChips({ nodeId }: { nodeId: string }): JSX.Element | null {
  const activeProjectId = useProjects((s) => s.activeProjectId)
  // useShallow: the array is derived fresh each call — its ELEMENTS are the cached faces.
  const faces = usePresence(
    useShallow((s) => selectFocusedFaces(s, nodeId, activeProjectId || null))
  )
  const typists = usePresence(useShallow((s) => selectTypingFaces(s, nodeId)))
  if (faces.length === 0 && typists.length === 0) return null

  const { chips, overflow, overflowTitle } = chipStrip(faces, typists)
  return (
    <span className="presence-chips">
      {chips.map((c) => (
        <span
          key={c.clientId}
          className={`presence-chip${c.typing ? ' presence-chip--typing' : ''}`}
          // `--peer-color` feeds the pulsing ring's keyframes (styles.css): the ring has to be in
          // the peer's own color, and a CSS animation cannot read an inline box-shadow.
          style={{ background: c.color, '--peer-color': c.color } as CSSProperties}
          title={c.title}
        >
          {c.letter}
        </span>
      ))}
      {overflow > 0 && (
        <span className="presence-chip presence-chip--more" title={overflowTitle}>
          +{overflow}
        </span>
      )}
    </span>
  )
}

export default PresenceChips
