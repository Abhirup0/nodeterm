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

/** All the facepile needs to know about the workspace: project id → display name. A flat record of
 *  STRINGS on purpose — the component derives it straight out of the projects store under
 *  `useShallow`, and a record of primitives is the only projection that is genuinely
 *  shallow-stable (an array of freshly built {id,name} objects compares unequal every time). */
export type FacepileProjects = Readonly<Record<string, string>>

/** clientId → the node that peer is focused on (null = nowhere). Focus changes when a teammate
 *  clicks into another node — not at cursor rate — so it is cheap for the facepile to know. */
export type FacepileFocus = Readonly<Record<number, string | null>>

/** True when the qualifier " · phone" would only repeat what the name already says (the hub's
 *  default name for a cursorless peer IS "Phone"). */
function nameSaysPhone(name: string): boolean {
  return /phone/i.test(name)
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
  /** True when a click actually takes us somewhere: we have their project (a peer on a canvas we
   *  do not have could only fail) AND there is somewhere to go — for a peer on the canvas we are
   *  already on that means a focused node, since "switch to this project" would be a no-op.
   *  Everyone still renders; a non-actionable face is just inert. */
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
 * reachable (clicking a teammate is a legitimate way off the welcome screen). `focus` says where
 * each peer is working: it is what makes a peer on OUR canvas worth clicking (there is a node to
 * centre on) — without it the click could only re-open the project we are already in.
 */
export function facepileEntries(
  faces: readonly PeerFace[],
  projects: FacepileProjects,
  activeProjectId: string | null,
  focus: FacepileFocus = {}
): FacepileEntry[] {
  const active = activeProjectId || null
  return faces.map((f) => {
    const projectName = f.projectId ? (projects[f.projectId] ?? null) : null
    const away = f.projectId !== active
    // Following a peer means opening their canvas (only possible for a project we have) or
    // centering their node. On our own canvas only the node is left — see FacepileEntry.actionable.
    const actionable = projectName !== null && (away || !!focus[f.clientId])
    const label = away && projectName ? `${f.name} · ${projectName}` : f.name
    const isPhone = f.kind === 'phone'
    const where = away
      ? projectName
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
      title: isPhone && !nameSaysPhone(f.name) ? `${where} · phone` : where,
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
  // No node to centre on: all that is left is opening their canvas — which is nowhere at all when
  // it is the canvas we are on (focus can go null between render and click, so re-check here).
  if (entry.away && entry.projectId) return { kind: 'project', projectId: entry.projectId }
  return null
}
