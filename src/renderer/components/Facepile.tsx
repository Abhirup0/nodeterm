import { useShallow } from 'zustand/react/shallow'
import { selectFaces, usePresence } from '../state/presence'
import { useProjects } from '../state/projects'
import { faceClickTarget, facepileEntries } from '../lib/facepile'

/**
 * Who is connected, top-right, in their colors. THE ONE SURFACE THAT SHOWS OFF-PROJECT PEERS:
 * cursors and node chips are hard-filtered to the active project (a project is a separate canvas
 * with its own coordinate space), but the facepile shows everybody — a peer on another project is
 * dimmed and labelled with that project's name ("Ada · api"). Clicking takes you to them: to their
 * focused node when they have one (focusNodeById switches projects on its own), else to their
 * project. Cursorless peers (phones) get a phone glyph — the facepile and the node chip are their
 * only surfaces, so being invisible here would mean being invisible entirely.
 *
 * PERF: subscribes to `selectFaces`, NOT `selectOthers` — the face projection is cursor-immune
 * (see state/presence.ts), so a peer moving their mouse at 20 Hz does not re-render this. The
 * peer's `focus` is deliberately not part of a face either; it is read from the store at CLICK
 * time (getState — no subscription).
 *
 * Renders nothing when you are alone: presence is silent, and costs nothing, solo.
 */
export function Facepile({
  onJump,
  onSwitchProject
}: {
  onJump: (nodeId: string) => void
  onSwitchProject: (projectId: string) => void
}): JSX.Element | null {
  // useShallow: the selector derives a new array each call (its ELEMENTS are cached — that is what
  // makes cursor traffic invisible here). See PresenceLayer for the same pattern.
  const faces = usePresence(useShallow(selectFaces))
  const activeProjectId = useProjects((s) => s.activeProjectId)
  // Only id+name: recomputing on every projects-store write is fine, re-rendering on one is not.
  const projects = useProjects(useShallow((s) => s.projects.map((p) => ({ id: p.id, name: p.name }))))
  if (faces.length === 0) return null

  const entries = facepileEntries(faces, projects, activeProjectId || null)

  return (
    <div className="presence-facepile">
      {entries.map((e) => (
        <button
          key={e.clientId}
          className={`presence-face${e.away ? ' presence-face--away' : ''}`}
          style={{ background: e.color }}
          title={e.title}
          disabled={!e.actionable}
          onClick={() => {
            // Read focus live: it is not part of a face (see PERF above), and by click time the
            // peer may well have moved to another node anyway.
            const focus = usePresence.getState().peers[e.clientId]?.focus ?? null
            const target = faceClickTarget(e, focus)
            if (target?.kind === 'node') onJump(target.nodeId)
            else if (target?.kind === 'project') onSwitchProject(target.projectId)
          }}
        >
          {e.isPhone ? (
            <span className="presence-face__phone" aria-hidden>
              ▯
            </span>
          ) : (
            e.initials
          )}
          {e.away && e.projectName ? (
            <span className="presence-face__where">{e.projectName}</span>
          ) : null}
        </button>
      ))}
    </div>
  )
}

export default Facepile
