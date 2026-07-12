import { useShallow } from 'zustand/react/shallow'
import { selectFaces, selectOthers, usePresence } from '../state/presence'
import { useProjects } from '../state/projects'
import { faceClickTarget, facepileEntries, type FacepileFocus } from '../lib/facepile'

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
 * (see state/presence.ts), so a peer moving their mouse at 20 Hz does not re-render this. `focus`
 * IS subscribed, but only as a clientId → nodeId record of STRINGS: it decides whether a face is
 * clickable at all (a peer on our own canvas is only worth clicking when they have a node to
 * centre on), and it changes when a teammate moves between nodes — not at cursor rate. The click
 * handler still reads focus live from the store (it can move between render and click).
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
  // Where each peer is working. A record of strings, so useShallow can actually compare it.
  const focus = usePresence(
    useShallow((s): FacepileFocus => {
      const map: Record<number, string | null> = {}
      for (const p of selectOthers(s)) map[p.clientId] = p.focus ?? null
      return map
    })
  )
  const activeProjectId = useProjects((s) => s.activeProjectId)
  // id → name, a record of STRINGS: useShallow compares the values with Object.is, so this
  // re-renders only when a project is added/removed/renamed — not on every projects-store write
  // (a node commit, a rename of some other project's node, dirty-marking). An array of freshly
  // built {id,name} objects would NOT be stable: Object.is on two new objects is always false.
  const projects = useProjects(
    useShallow((s): Record<string, string> => {
      const names: Record<string, string> = {}
      for (const p of s.projects) names[p.id] = p.name
      return names
    })
  )
  if (faces.length === 0) return null

  const entries = facepileEntries(faces, projects, activeProjectId || null, focus)

  return (
    <div className="presence-facepile">
      {entries.map((e) => (
        <button
          key={e.clientId}
          type="button"
          className={`presence-face${e.away ? ' presence-face--away' : ''}`}
          style={{ background: e.color }}
          title={e.title}
          // aria-disabled, NOT `disabled`: Chromium (Electron and the browser edition alike)
          // suppresses mouse events on a disabled button, so its `title` never shows — and the
          // tooltip ("Ada — on a canvas you do not have") is the whole point exactly there.
          // Screen readers still announce it as unavailable; the click is a no-op.
          aria-disabled={!e.actionable}
          onClick={() => {
            if (!e.actionable) return
            // Read focus live: the subscribed map above is what decided actionability, but by
            // click time the peer may well have moved to another node.
            const live = usePresence.getState().peers[e.clientId]?.focus ?? null
            const target = faceClickTarget(e, live)
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
