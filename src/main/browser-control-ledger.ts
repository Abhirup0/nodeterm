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

/**
 * The refusal a drive gets after the USER stopped control of a node (PR 6 Task 6.4). Named after the
 * human act, not a permissions verdict, so the agent REPORTS it ("the user stopped me") instead of
 * retrying an outage. Consulted by the drive path in PR 7 via {@link BrowserControlLedger.wasStoppedByUser};
 * the `browser-3:` prefix matches the numbered refusal family (`browser-1`/`browser-2` in the shim).
 */
export const BROWSER_USER_STOPPED = 'browser-3: the user stopped agent control of this node'

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
   * browserNodeId → the owner the USER stopped control for. A tombstone, not an entry: it outlives
   * the deleted ownership so a subsequent drive from that same owner answers {@link BROWSER_USER_STOPPED}
   * instead of the generic not-owned null (which reads as "retryable"). Set ONLY by {@link stopByUser}
   * (chip/menu/Settings/switch-off — the human acts), never by lifecycle revocation (node/project
   * close, owner gone, quit), and cleared by a fresh {@link claim} so re-opening a node is a clean
   * slate. In-memory like the ledger itself — a restart forgets it, which is correct.
   */
  private readonly userStopped = new Map<string, string>()

  /**
   * Record ownership of a freshly opened browser node. Returns false — and changes NOTHING — if the
   * id is already claimed: there is NO handoff, claim or transfer (S8's `claimUserTab` is dropped),
   * so a live browser node's owner never changes and the user's own browsing never becomes an
   * agent's. A blank `browserNodeId`, `ownerNodeId` or `projectId` is refused: there is no anonymous
   * owner, and a project-less entry is meaningless (it would also make `releaseByProject('')` match
   * it) — the belt to main's wiring guard against a future reply-shape that drops the project id.
   */
  claim(browserNodeId: string, e: AgentBrowserEntry): boolean {
    if (!browserNodeId || !e.ownerNodeId || !e.projectId) return false
    if (this.entries.has(browserNodeId)) return false
    this.entries.set(browserNodeId, { ...e })
    // A fresh, verified open is a clean slate: a node the user stopped earlier and then genuinely
    // re-opened is drivable again. (Ids are not reused within a run, so in practice this clears a
    // stale tombstone rather than masking a live refusal.)
    this.userStopped.delete(browserNodeId)
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

  /** The same live set, shaped for the renderer push (adds `leaseActiveUntil` so the chip can apply
   *  its linger). Separate from {@link activeLeases} so that method's asserted shape is untouched. */
  activeLeasesForPush(now: number): {
    browserNodeId: string
    ownerNodeId: string
    leaseActiveUntil: number
  }[] {
    const live: { browserNodeId: string; ownerNodeId: string; leaseActiveUntil: number }[] = []
    for (const [browserNodeId, e] of this.entries) {
      if (e.leaseActiveUntil > now) {
        live.push({ browserNodeId, ownerNodeId: e.ownerNodeId, leaseActiveUntil: e.leaseActiveUntil })
      }
    }
    return live
  }

  /**
   * The USER stopped control of this node (chip/menu/Settings/switch-off). Records the tombstone
   * against its current owner FIRST, then drops the entry — so a later drive from that owner is
   * refused with the named human act, not the generic null. A no-op tombstone-wise if the node was
   * already unclaimed (nothing to name an owner). Lifecycle revocation uses {@link release}, which
   * leaves no tombstone.
   */
  stopByUser(browserNodeId: string): void {
    const entry = this.entries.get(browserNodeId)
    if (entry) this.userStopped.set(browserNodeId, entry.ownerNodeId)
    this.entries.delete(browserNodeId)
  }

  /** Did the user stop control of this node for THIS exact owner? The drive path (PR 7) asks this to
   *  choose {@link BROWSER_USER_STOPPED} over a retry. Owner-scoped so it can never leak node
   *  existence to a different agent than the one that was driving. */
  wasStoppedByUser(browserNodeId: string, ownerNodeId: string): boolean {
    return this.userStopped.get(browserNodeId) === ownerNodeId
  }

  /** Every browser node this owner opened (claimed, live-lease or not) — the set to revoke when the
   *  owner node closes or restarts. */
  idsByOwner(ownerNodeId: string): string[] {
    return this.idsWhere((e) => e.ownerNodeId === ownerNodeId)
  }

  /** Every browser node opened under this project — the set to revoke when the project's switch goes
   *  off (a project close revokes per-node via the guest teardown instead). */
  idsByProject(projectId: string): string[] {
    return this.idsWhere((e) => e.projectId === projectId)
  }

  /** Every claimed browser node — the set to revoke on app quit. */
  allIds(): string[] {
    return [...this.entries.keys()]
  }

  private idsWhere(pred: (e: AgentBrowserEntry) => boolean): string[] {
    const ids: string[] = []
    for (const [browserNodeId, e] of this.entries) if (pred(e)) ids.push(browserNodeId)
    return ids
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
