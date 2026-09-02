// Consent copy for inviting/approving a remote peer.
//
// Inviting a peer grants SHELL ACCESS — the invite/approve UI must say so in plain words. Per the
// spec's "Full trust, explicitly granted" decision, there is no per-action approval and no directory
// jail: the boundary is WHO you invite. So the copy is honest about the size of the grant. Lives in
// src/shared (not src/main) because the renderer invite/approve UI shows it and cannot import main.
//
// Wording is the DESKTOP invite copy from docs/remote-sessions.md ("run commands on this
// <machine> — the same as giving them SSH access").
//
// The machine is NAMED BY THE CALLER (issue #563). This module is shared, so it cannot ask the
// renderer what this OS calls its computer, and the default has to be the neutral word: a
// hard-coded "Mac" is a false claim in the one sentence a user must read before handing out shell
// access. The renderer passes `thisMachine()` (lib/machineName).

const DEFAULT_MACHINE = 'this computer'

const grantTail = (machine: string): string =>
  ` will be able to run commands on ${machine} — the same as giving them SSH access.`

/** No-name fallback sentence (also returned by describeGrant for a blank label). */
export function shellAccessConsent(machine: string = DEFAULT_MACHINE): string {
  return `This device${grantTail(machine)}`
}

/** No-name fallback with the neutral machine word — for callers that name no machine. */
export const SHELL_ACCESS_CONSENT = shellAccessConsent()

/** The consent sentence naming the peer; blank labels fall back to the no-name sentence. */
export function describeGrant(peerLabel: string, machine: string = DEFAULT_MACHINE): string {
  const who = peerLabel.trim()
  return who ? `${who}${grantTail(machine)}` : shellAccessConsent(machine)
}
