import { useShallow } from 'zustand/react/shallow'
import { selectFocusedFaces, usePresence } from '../state/presence'
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
 * PERF: THIS component subscribes to the presence store, not TerminalNode — and it subscribes to
 * FACES, not PeerStates. A cursor patch rebuilds a peer's PeerState object ~20×/s, so a PeerState
 * selector would re-render every terminal node on the canvas at cursor rate; faces are the same
 * objects until a name/color/project/kind actually changes, so `useShallow` bails out and a moving
 * cursor re-renders nothing here. (`PeerState.typing` is Stage 2's; Stage 1 leaves it null and
 * draws no typing indicator.)
 */
export function PresenceChips({ nodeId }: { nodeId: string }): JSX.Element | null {
  const activeProjectId = useProjects((s) => s.activeProjectId)
  // useShallow: the array is derived fresh each call — its ELEMENTS are the cached faces.
  const faces = usePresence(
    useShallow((s) => selectFocusedFaces(s, nodeId, activeProjectId || null))
  )
  if (faces.length === 0) return null

  const { chips, overflow, overflowTitle } = chipStrip(faces)
  return (
    <span className="presence-chips">
      {chips.map((c) => (
        <span
          key={c.clientId}
          className="presence-chip"
          style={{ background: c.color }}
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
