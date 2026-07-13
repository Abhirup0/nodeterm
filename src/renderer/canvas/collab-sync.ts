import type { NodeTerminalApi } from '@shared/types'
import type { WorkspaceSession } from '../session/session'

/**
 * Task 4's whole fix in one pure place: the canvas-sync PUBLISHER + the onMutation SUBSCRIBER must
 * hit the ACTIVE session's core, and the solo publish gate must count the ACTIVE session's presence
 * peers — NOT the LOCAL session's. The bug this replaces: on a relay tab the publisher mutated B's
 * OWN local core (never the relay host) and gated on the empty local presence, so `hasPeers` was
 * false and a node B opened never reached A.
 *
 * The `peers` table includes ourselves, so `> 1` means a teammate is attached (the same predicate
 * the presence session's own solo gate uses). Kept a pure `(session, presenceState) → target` so it
 * is unit-testable without rendering Canvas: a relay session yields the relay api + its peer count,
 * a local session yields `window.nodeTerminal` + the local peer count — byte-identical to today.
 */
export function canvasSyncTarget(
  session: WorkspaceSession,
  presenceState: { peers: Record<string, unknown> }
): { api: NodeTerminalApi; hasPeers: boolean } {
  return { api: session.api, hasPeers: Object.keys(presenceState.peers).length > 1 }
}
