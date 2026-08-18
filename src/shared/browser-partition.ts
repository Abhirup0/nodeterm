import { isSafeNodeId } from './safe-id'

/**
 * The session partition for a browser node an AGENT opened.
 *
 * User-opened nodes keep the default session, unchanged — that is what makes this a zero-migration
 * change: every existing browser node was user-opened (or restored, hence un-owned), so nobody
 * loses a login on upgrade. A blanket per-node partitioning WOULD have logged everyone out once.
 * [MEASURED 2026-08, Electron 42.8.1] a partition-less `<webview>` genuinely shares
 * `session.defaultSession` with the app window — so an agent node left on the default session would
 * read whatever the user is already logged into (see the probe doc, Probe A).
 *
 * PER-PROJECT, not per-node: per-node means re-logging-in for every open-browser, which makes
 * multi-tab agentic work (compare two pages, open a link in a second node) impractical. Not global:
 * a login an agent made for project A has no business being available to an agent in project B.
 *
 * The property this buys, and it is the one the owner asked about: an agent driving node A cannot
 * reach node B's logins, where B is anything the user opened. The cost is the mirror image — the
 * user cannot log in on the agent's behalf from their OWN node; they must log in inside the agent's
 * node, which is where the indicator is.
 *
 * `projectId` is validated because it arrives from git-shared project.json and becomes a PERSISTED
 * STORAGE KEY. Returns null rather than throwing: the caller refuses the open, it does not crash.
 * The guard is load-bearing and pinned by `browser-partition.test.ts` ("REFUSES an id isSafeNodeId
 * refuses"); drop it and that test goes red.
 *
 * [MEASURED 2026-08, Electron 42.8.1 — see docs/superpowers/probes/2026-08-browser-partition.md]
 * A discarded+restored webview rejoins the same named partition (Probe B), and `partition` is
 * honoured only at attach — a post-attach mutation is silently ignored (Probe C) — which is why the
 * node's field is set once at creation and never mutated.
 */
export function agentBrowserPartition(projectId: string): string | null {
  if (!isSafeNodeId(projectId)) return null
  return `persist:nt-agent-browser-${projectId}`
}
