/**
 * Who may drive which browser node, for THIS APP RUN ONLY.
 *
 * IN MEMORY, IN MAIN, NEVER PERSISTED, AND NEVER READ FROM project.json. The obvious
 * implementation — "the agent may drive the browser node it opened, so read the rope" — is the same
 * supply-chain class as bypassPermissions, which the owner already ruled out for exactly this
 * reason. `Project.ropes` is documented as DISPLAY-ONLY but PERSISTED (shared/types.ts), so a
 * hostile cloned project.json can ship a pre-declared rope from claude-1 to browser-1, and any
 * ownership check that reads `ropes` grants on it. `browser-ownership-source.test.ts` (Task 4.4)
 * fails if any ownership path ever reads `ropes`.
 *
 * The cost is real and is paid deliberately: browser control does not survive an app restart. An
 * agent mid-task across a restart must open-browser again and log in again.
 *
 * Only a successful `open-browser` from a VERIFIED caller creates an entry (`claim`, called on the
 * renderer's `{ id }` reply, gated on the request's `verified` verdict in main). A node the user
 * opened is never in here and is therefore invisible and undrivable — including the "New browser"
 * menu item, a pop-up captured from a user-opened node, and EVERY browser node restored from
 * project.json at load. Kept from S8, which had this one property right.
 *
 * This is the browser sibling of `core/agents/pane-ownership.ts` (messaging's runtime ledger): same
 * shape, same fail-closed lessons — record at CREATE from a non-forgeable source (main's own
 * `verified` verdict, not the file), an absent entry and a disagreement are both REFUSED, and
 * `get` deliberately cannot distinguish "not yours" from "does not exist". It lives in `src/main`,
 * not `src/core`, because its clients are Electron-adjacent (webContents leases, PR 5/6) and it is
 * never needed on the Server Edition, where browser control cannot exist.
 */

export interface AgentBrowserEntry {
  /** The agent node that ran open-browser. Drives are admitted only for THIS owner. */
  ownerNodeId: string
  /** The project that owned the open. */
  projectId: string
  /** The session jar the guest attached on (`persist:nt-agent-browser-<projectId>`). */
  partition: string
  /** Bumped by Page.frameNavigated; invalidates every @ref (PR 5 Task 5.5). */
  navGeneration: number
  /** Drives the indicator (PR 6) and the discard suppression (PR 5 Task 5.4). */
  leaseActiveUntil: number
  openedAt: number
}

export class BrowserControlLedger {
  /** browserNodeId → its ownership entry, for browser nodes an agent opened THIS run. */
  private readonly entries = new Map<string, AgentBrowserEntry>()

  /**
   * Record ownership of a freshly opened browser node. Returns false — and changes NOTHING — if the
   * id is already claimed: there is NO handoff, claim or transfer (S8's `claimUserTab` is dropped),
   * so a live browser node's owner never changes and the user's own browsing never becomes an
   * agent's. A blank `browserNodeId` or `ownerNodeId` is refused (there is no anonymous owner).
   */
  claim(browserNodeId: string, e: AgentBrowserEntry): boolean {
    if (!browserNodeId || !e.ownerNodeId) return false
    if (this.entries.has(browserNodeId)) return false
    this.entries.set(browserNodeId, { ...e })
    return true
  }

  /**
   * The entry IF this exact owner opened this exact node this run, else null. The answer for "does
   * not exist" and "exists but is not yours" is IDENTICAL by design (both null): a distinct message
   * would be a node-enumeration oracle. Rule adopted verbatim from S8's requireTab.
   */
  get(browserNodeId: string, ownerNodeId: string): AgentBrowserEntry | null {
    const entry = this.entries.get(browserNodeId)
    if (!entry || entry.ownerNodeId !== ownerNodeId) return null
    return entry
  }

  /** Drop one node's ownership — its session is ending. Undrivable again until a fresh claim. */
  release(browserNodeId: string): void {
    this.entries.delete(browserNodeId)
  }

  /** Release every node this owner opened (the owner node was deleted/detached); returns their ids. */
  releaseByOwner(ownerNodeId: string): string[] {
    return this.releaseWhere((e) => e.ownerNodeId === ownerNodeId)
  }

  /** Release every node opened under this project (the project closed); returns their ids. */
  releaseByProject(projectId: string): string[] {
    return this.releaseWhere((e) => e.projectId === projectId)
  }

  /** Release everything (app teardown); returns every released id. */
  releaseAll(): string[] {
    return this.releaseWhere(() => true)
  }

  /** Extend a node's lease (drives the indicator + discard suppression). No-op if unclaimed. */
  touchLease(browserNodeId: string, until: number): void {
    const entry = this.entries.get(browserNodeId)
    if (entry) entry.leaseActiveUntil = until
  }

  /** Nodes whose lease is still live at `now` — the indicator (PR 6) and discard-suppression set. */
  activeLeases(now: number): { browserNodeId: string; ownerNodeId: string }[] {
    const live: { browserNodeId: string; ownerNodeId: string }[] = []
    for (const [browserNodeId, e] of this.entries) {
      if (e.leaseActiveUntil > now) live.push({ browserNodeId, ownerNodeId: e.ownerNodeId })
    }
    return live
  }

  private releaseWhere(pred: (e: AgentBrowserEntry) => boolean): string[] {
    const released: string[] = []
    for (const [browserNodeId, e] of this.entries) {
      if (pred(e)) released.push(browserNodeId)
    }
    for (const id of released) this.entries.delete(id)
    return released
  }
}
