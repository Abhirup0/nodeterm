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

/**
 * The partition a PERSISTED browser node is allowed to keep when it is LOADED.
 *
 * `agentBrowserPartition` validates the id at CREATE, but `data.partition` is then persisted and
 * `.nodeterm/project.json` is hostile input (git-shared, hand-editable, auto-adopted — constraint
 * 10), and the field is copied verbatim to `<webview partition>`. Without a load-path gate a hostile
 * clone could ship a browser node whose stored `partition` names ANOTHER project's jar
 * (`persist:nt-agent-browser-<victim>`) or is a non-`isSafeNodeId` storage-key string, and it would
 * reach Electron unchecked — forging jar identity the per-project isolation exists to prevent.
 *
 * The rule: a stored partition survives ONLY when it is EXACTLY the one THIS project would mint for
 * itself (`agentBrowserPartition(projectId)`). Anything else — a foreign project's id, a different
 * machine's id from a clone, an unsafe/oddly-shaped string — drops to `undefined`, i.e. partition-
 * less / default session / un-owned (the probe's user-opened clause). This is the single load gate:
 * the value is not re-validated after it, so it runs at the adopt boundary (`fileToProject`, which
 * is where the machine-local `projectId` is authoritative and never the file's own id). Pinned by
 * `browser-partition.test.ts` and the hostile-project.json case in `workspace-files.test.ts`; a
 * missing gate lets `persist:nt-agent-browser-victim` reach the webview.
 */
export function loadedAgentBrowserPartition(
  partition: string | undefined,
  projectId: string
): string | undefined {
  if (!partition) return undefined
  return partition === agentBrowserPartition(projectId) ? partition : undefined
}
