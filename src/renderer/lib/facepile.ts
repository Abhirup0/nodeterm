// Pure logic behind the presence facepile (components/Facepile.tsx): what each avatar is labelled
// with, whether it is dimmed, and where clicking it takes you. Kept out of the component because
// vitest runs in the node environment (no jsdom), so a React component cannot be unit-tested —
// this can.
//
// THE FACEPILE IS THE ONE PRESENCE SURFACE THAT DOES NOT PROJECT-FILTER. Cursors (PresenceLayer)
// and node chips are hard-filtered to the active project — a peer's flow coordinates and node ids
// mean nothing on another canvas. The facepile instead shows EVERYONE, dims the peers who are on
// another canvas, labels them with the project they are in ("Ada · api"), and makes them clickable:
// "why can't I see them?" becomes "who is working where".

import type { PeerFace } from '../state/presence'

/** The minimum a project has to be for the facepile: an id and a display name (structural, so the
 *  helper stays testable without the whole Project type). */
export interface FacepileProject {
  id: string
  name: string
}

export interface FacepileEntry {
  clientId: number
  name: string
  color: string
  /** Two letters for the avatar circle. */
  initials: string
  /** A cursorless peer (a phone): the facepile is its only surface, so it gets a phone glyph. */
  isPhone: boolean
  /** On another canvas (or on none) — rendered dimmed. */
  away: boolean
  projectId: string | null
  /** The name of the project they are in, or null when they are in none / one we do not have. */
  projectName: string | null
  /** "Ada · api" for a known off-project peer, plain "Ada" otherwise (NEVER "Ada · undefined"). */
  label: string
  title: string
  /** True when we can actually follow them (we have their project). Clicking a peer whose project
   *  is not in our workspace could only fail, so their avatar is inert. */
  actionable: boolean
}

/** Where a click on a face goes: to the node the peer is working in, else to their canvas. */
export type FaceTarget =
  | { kind: 'node'; nodeId: string }
  | { kind: 'project'; projectId: string }
  | null

/** Two-letter initials for the avatar circle ("Enes Kirca" → "EK", "Phone" → "PH"). */
export function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean)
  if (parts.length === 0) return '?'
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase()
  return (parts[0][0] + parts[1][0]).toUpperCase()
}

/**
 * Project the cursor-immune faces (selectFaces) into what the facepile draws. `activeProjectId`
 * is the canvas WE are on — null/'' on the welcome screen, where everyone is "away" but still
 * reachable (clicking a teammate is a legitimate way off the welcome screen).
 */
export function facepileEntries(
  faces: readonly PeerFace[],
  projects: readonly FacepileProject[],
  activeProjectId: string | null
): FacepileEntry[] {
  const active = activeProjectId || null
  const names = new Map(projects.map((p) => [p.id, p.name]))
  return faces.map((f) => {
    const projectName = f.projectId ? (names.get(f.projectId) ?? null) : null
    const away = f.projectId !== active
    // Following a peer means opening their canvas — only possible for a project we have.
    const actionable = projectName !== null
    const label = away && projectName ? `${f.name} · ${projectName}` : f.name
    const isPhone = f.kind === 'phone'
    const where = away
      ? actionable
        ? `${label} (click to go there)`
        : f.projectId
          ? `${f.name} — on a canvas you do not have`
          : `${f.name} — no project open`
      : f.name
    return {
      clientId: f.clientId,
      name: f.name,
      color: f.color,
      initials: initials(f.name),
      isPhone,
      away,
      projectId: f.projectId,
      projectName,
      label,
      title: isPhone ? `${where} · phone` : where,
      actionable
    }
  })
}

/**
 * Where clicking this face takes you. `focus` is read from the live store AT CLICK TIME (it is
 * deliberately not part of PeerFace — the facepile must not re-render when a peer changes node),
 * so this stays pure and the component stays cursor-immune.
 *
 * A focused node wins: Canvas.focusNodeById already switches projects for a node that lives in
 * another one, so one call both travels and centers. Otherwise we can only land on their canvas.
 */
export function faceClickTarget(entry: FacepileEntry, focus: string | null): FaceTarget {
  if (!entry.actionable) return null
  if (focus) return { kind: 'node', nodeId: focus }
  if (entry.projectId) return { kind: 'project', projectId: entry.projectId }
  return null
}
