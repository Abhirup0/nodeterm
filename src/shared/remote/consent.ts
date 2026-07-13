// Consent copy for inviting/approving a remote peer.
//
// Inviting a peer grants SHELL ACCESS — the invite/approve UI must say so in plain words. Per the
// spec's "Full trust, explicitly granted" decision, there is no per-action approval and no directory
// jail: the boundary is WHO you invite. So the copy is honest about the size of the grant. Lives in
// src/shared (not src/main) because the renderer invite/approve UI shows it and cannot import main.
//
// Wording is the DESKTOP invite copy verbatim from docs/remote-sessions.md ("run commands on this
// Mac — the same as giving them SSH access").

const GRANT_TAIL = ' will be able to run commands on this Mac — the same as giving them SSH access.'

/** No-name fallback sentence (also returned by describeGrant for a blank label). */
export const SHELL_ACCESS_CONSENT = `This device${GRANT_TAIL}`

/** The consent sentence naming the peer; blank labels fall back to SHELL_ACCESS_CONSENT. */
export function describeGrant(peerLabel: string): string {
  const who = peerLabel.trim()
  return who ? `${who}${GRANT_TAIL}` : SHELL_ACCESS_CONSENT
}
