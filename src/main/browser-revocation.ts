/**
 * Revoking browser control — the security-relevant half of the indicator (S8 PR 6 of #112, @Corvin).
 *
 * A Stop that only hides the chip is a Critical-class bug: the debugger would stay attached and the
 * page still drivable. So every revocation here does BOTH, in one place, whatever triggered it:
 *   1. drop the ownership entry (undrivable — the ledger's `get` now returns null), and
 *   2. release the lease, which DETACHES the debugger and rejects any in-flight verb with a named
 *      outcome (`BrowserSession.release` → `detach()` + `BROWSER_LEASE_DETACHED`).
 *
 * A USER-initiated stop (chip, node menu, Settings kill row, the project switch going off) also
 * leaves a tombstone, so the next drive from that owner is refused with {@link BROWSER_USER_STOPPED}
 * — a message naming the human act, so the agent reports it rather than retrying. LIFECYCLE
 * revocation (node close, project close, owner gone, app quit) leaves no tombstone: nothing there is
 * "the user stopped control of this node".
 *
 * Ownership is read ONLY from the injected ledger — never from `Project` edges (that identifier is
 * forbidden in every `src/main/browser-*.ts`, pinned by browser-ownership-source.test.ts). This file
 * knows nothing of project.json.
 *
 * `src/main`, never Server Edition: it releases a `webContents.debugger`, which cannot exist there.
 */
import type { BrowserControlLedger } from './browser-control-ledger'

/** The two runtime holders a revocation touches, injected so the whole thing unit-tests against a
 *  real {@link BrowserControlLedger} and a real `BrowserLeaseManager` (or fakes) with no Electron. */
export interface RevocationTargets {
  /** The lease manager. `release(nodeId)` detaches the debugger + rejects in-flight (a no-op for a
   *  node with no live session — true today, before PR 7 attaches any). */
  leases: { release(nodeId: string): void }
  /** The ownership + tombstone ledger. */
  ledger: BrowserControlLedger
}

/** Revoke a set of browser nodes. `userStopped` chooses the tombstone (human act) vs a plain drop
 *  (lifecycle). Returns the ids acted on, so the caller can push them to the renderer as `stopped`
 *  (drop the chip at once, skipping the linger). */
export function revokeBrowserNodes(
  browserNodeIds: readonly string[],
  t: RevocationTargets,
  opts: { userStopped: boolean }
): string[] {
  for (const id of browserNodeIds) {
    // Ledger first so the node is undrivable the instant the debugger lets go; the tombstone must be
    // recorded BEFORE the entry is dropped, which `stopByUser` does internally.
    if (opts.userStopped) t.ledger.stopByUser(id)
    else t.ledger.release(id)
    t.leases.release(id)
  }
  return [...browserNodeIds]
}

/** One node — the chip's Stop and the node context menu (userStopped), or a single node closing
 *  (lifecycle). */
export function revokeBrowserNode(
  browserNodeId: string,
  t: RevocationTargets,
  opts: { userStopped: boolean }
): string[] {
  return revokeBrowserNodes([browserNodeId], t, opts)
}

/** Every node an owner opened — the owner agent node closing or restarting (lifecycle). */
export function revokeBrowserByOwner(ownerNodeId: string, t: RevocationTargets): string[] {
  return revokeBrowserNodes(t.ledger.idsByOwner(ownerNodeId), t, { userStopped: false })
}

/** Every node in a project — the project switch going OFF (userStopped: a human act, refused with
 *  the named message afterwards). A project CLOSE is handled per-node by the guest teardown instead,
 *  and is not a "stop", so it does not come through here. */
export function revokeBrowserByProject(projectId: string, t: RevocationTargets): string[] {
  return revokeBrowserNodes(t.ledger.idsByProject(projectId), t, { userStopped: true })
}

/** Every claimed node — the Settings kill row's Stop-all (userStopped). */
export function revokeAllBrowser(t: RevocationTargets, opts: { userStopped: boolean }): string[] {
  return revokeBrowserNodes(t.ledger.allIds(), t, opts)
}
