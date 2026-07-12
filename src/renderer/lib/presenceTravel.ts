// Pure routing logic behind "go to where my teammate is" (the facepile's click, see
// components/Facepile.tsx). Kept out of Canvas because vitest runs in the node environment (no
// jsdom), so a React component cannot be unit-tested — this can.
//
// WHY THIS EXISTS AT ALL: the facepile deliberately shows peers who are NOT on our canvas, and a
// peer may well be working in a project we have CLOSED. A closed project is still in the projects
// store (`closed: true`) — it is only hidden from the tab bar — so a bare `setActive` would make an
// invisible project the active canvas. Travelling to it must go through `reopenProject` instead.
// And a project that is closed AND `unavailable` (its .nodeterm file is unreadable — folder moved
// or unmounted) must not be travelled to at all: reopening it would load an empty canvas, exactly
// the case Canvas already excludes from the welcome screen's "Recently closed" list.

/** The little the routing needs to know about a project. */
export interface TravelProject {
  id: string
  closed?: boolean
  unavailable?: boolean
  nodes: { id: string }[]
}

/**
 * What Canvas should do to land on a peer's canvas:
 * - `none`    — nothing to do (already there, or we have no such project/node).
 * - `switch`  — an open project: the normal tab switch.
 * - `reopen`  — a closed project: restore its tab, then activate it.
 * - `blocked` — a project whose files we cannot read: travelling there would show an empty canvas.
 */
export type Travel =
  | { kind: 'none' }
  | { kind: 'blocked' }
  | { kind: 'switch'; projectId: string }
  | { kind: 'reopen'; projectId: string }

/** How to get to `targetId` from the project we are on (`activeProjectId`, '' on the welcome
 *  screen). */
export function projectTravel(
  projects: readonly TravelProject[],
  activeProjectId: string,
  targetId: string
): Travel {
  const target = projects.find((p) => p.id === targetId)
  if (!target) return { kind: 'none' } // a canvas we do not have — the facepile marks it inert
  if (target.unavailable) return { kind: 'blocked' }
  if (target.id === activeProjectId && !target.closed) return { kind: 'none' }
  if (target.closed) return { kind: 'reopen', projectId: target.id }
  return { kind: 'switch', projectId: target.id }
}

/** How to get to the project that owns `nodeId` — the travel half of "jump to the node my teammate
 *  is working in". `none` also covers "the node is on the canvas we are already on": there is no
 *  travel to do, only a focus. */
export function nodeTravel(
  projects: readonly TravelProject[],
  activeProjectId: string,
  nodeId: string
): Travel {
  const owner = projects.find((p) => p.nodes.some((n) => n.id === nodeId))
  if (!owner) return { kind: 'none' }
  return projectTravel(projects, activeProjectId, owner.id)
}
