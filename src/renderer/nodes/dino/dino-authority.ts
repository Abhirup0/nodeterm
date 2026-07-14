import type { ClientId } from '@shared/presence'

/**
 * The authority tiebreak for a live dino node. A pure decision so it can be unit-tested apart from
 * the canvas engine and the presence store.
 *
 * `selectDino` already hands us the LOWEST-clientId OTHER peer broadcasting for this node (or null),
 * so the only question left is whether that peer beats US: if I currently author a run and my own
 * clientId is lower than the peer's, I keep playing (the peer will see my broadcast and yield);
 * otherwise I spectate. Lower clientId always wins, which is what makes every client converge on one
 * authority during a take-over race.
 *
 * - `peerClientId === null` → nobody is broadcasting for this node → play locally (never spectate).
 * - `myId === null` (hello in flight) → I cannot win the tiebreak, so I spectate.
 */
export function shouldSpectate(args: {
  myId: ClientId | null
  peerClientId: ClientId | null
  iAmAuthority: boolean
}): boolean {
  const { myId, peerClientId, iAmAuthority } = args
  if (peerClientId === null) return false // no peer authoring this node → play locally
  // A peer is broadcasting. Spectate UNLESS I already author AND my clientId wins (lower wins).
  if (iAmAuthority && myId !== null && myId < peerClientId) return false
  return true
}
