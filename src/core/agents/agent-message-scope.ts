import type { NotPermittedReason } from './agent-message-decide'

/**
 * WHO MAY BE ADDRESSED — the project boundary, resolved off the SERIALIZED store.
 *
 * A message crosses into another agent's session, so the question "is this target mine to write
 * to?" has to be answered before anything else happens, and it has to be answered from a source of
 * truth that covers every project rather than the one that happens to be on screen.
 *
 * ── WHY THE SERIALIZED STORE AND NOT THE LIVE CANVAS ────────────────────────────────────────────
 *
 * React Flow only ever holds the ACTIVE project's nodes (`nodesRef`), while the tmux sessions of
 * every other open project keep running. Resolving a target against `nodesRef` therefore answers
 * "not on the canvas" for every node outside the current tab — the same defect `routeControlSource`
 * exists to fix on the source side, where it surfaced as a lost capability rather than as the wrong
 * canvas answering.
 *
 * The fix is NOT to travel to the target's project. `send` is declared outside `needsLiveCanvas`
 * precisely so it never can: travelling would yank the human's view to another tab on a background
 * agent's say-so, and `setActive` on the way would clear that node's unread badge — a delivery
 * silently erasing the signal a human relies on (G5). So this resolver takes the projects store and
 * NOTHING else. There is no parameter for a live node list, which is a guarantee a test can check
 * by running it: a node the live canvas has but the store has not is refused, not admitted.
 *
 * ── THREE SURFACES ──────────────────────────────────────────────────────────────────────────────
 *
 * - **Desktop (Electron):** the caller. It passes `useProjects.getState().projects`, the same
 *   serialized array `routeControlSource` and `storedNodeListing` already read.
 * - **Server Edition:** ships, unused — messaging does not exist there (Task 5.3). Pure, with no
 *   electron or main-shell import, so it ships on both shells like everything else in `src/core`.
 * - **Mobile (phone):** never a sender, so it never calls this. A phone-spawned node IS a valid
 *   target and is resolved exactly like any other: it is a node id in a persisted project.
 *
 * ── WHICH WAY IT FAILS ──────────────────────────────────────────────────────────────────────────
 *
 * CLOSED, because the thing being authorised is a write into someone else's terminal. Anything this
 * cannot positively resolve to a single shared project is refused: a source that belongs to no
 * project the store knows, a target that resolves nowhere, a target in a project the store has but
 * the sender does not share. `notPermitted` is not retryable, so a refusal here is terminal — which
 * is correct for a boundary and would be wrong for a timing problem, and none of these are timing
 * problems.
 */

/** The little this needs from a project — a structural subset of both `Project` and the store's
 *  serialized `ProjectFileV1`, so either can be passed without adaptation. */
export interface ScopeProject {
  id: string
  nodes: readonly { id: string }[]
}

export type ScopeRefusal = Extract<NotPermittedReason, 'self-send' | 'cross-project'>

export type DeliveryScope =
  | { kind: 'same-project'; projectId: string }
  | {
      kind: 'refused'
      reason: ScopeRefusal
      /** Does this target id exist in ANY project the store knows? `false` separates "aimed at
       *  another project" from "aimed at nothing" — the same refusal, but only one of them is
       *  worth telling a human about. */
      targetFound: boolean
    }

/**
 * Resolve a (source, target) pair to the project they share, or to the refusal that stops it.
 *
 * `self-send` is checked first and is the same rule, in the same words, that the manual
 * `onConnect` already applies to a canvas edge — a node may not be wired to itself. It is decided
 * before project membership because it is true regardless of where either id lives, including when
 * neither lives anywhere.
 *
 * Note that this is the OUTER guard, not the only one: `decidePreProbe` carries its own self-send
 * backstop so that no future caller can forget this one. Both produce the identical
 * `notPermitted{reason:'self-send'}`, which the test asserts by running them.
 *
 * A duplicate node id across two projects (a cloned `project.json` — this repo has shipped that
 * bug once) resolves to the SOURCE's project when the source's project is one of them: the sender
 * addresses the node it can see, and the ambiguity never reaches the pane.
 *
 * `closed` and `unavailable` projects are deliberately NOT filtered out. A closed project's tmux
 * sessions keep running and are re-adopted on the next start — that is the whole premise of
 * `routeControlSource` — and a delivery goes to a pane, not to a canvas. Filtering them would
 * refuse a perfectly deliverable message on the grounds that a tab is shut.
 */
export function resolveDeliveryScope(
  projects: readonly ScopeProject[],
  sourceNodeId: string,
  targetNodeId: string
): DeliveryScope {
  const has = (p: ScopeProject, id: string): boolean => p.nodes.some((n) => n.id === id)
  const targetFound = projects.some((p) => has(p, targetNodeId))
  if (sourceNodeId === targetNodeId) return { kind: 'refused', reason: 'self-send', targetFound }
  const owner = projects.find((p) => has(p, sourceNodeId))
  if (owner && has(owner, targetNodeId)) return { kind: 'same-project', projectId: owner.id }
  return { kind: 'refused', reason: 'cross-project', targetFound }
}

/** The `notPermitted` fact `decideDelivery` takes, or `undefined` when the pair may proceed.
 *  Keeping the mapping here means a caller cannot invent a third answer. */
export function scopeRefusal(scope: DeliveryScope): NotPermittedReason | undefined {
  return scope.kind === 'refused' ? scope.reason : undefined
}
