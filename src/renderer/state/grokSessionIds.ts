// Which session ids grok already owns, per cwd — warmed in the renderer so the SYNC node factory can
// consult it.
//
// Why a memo and not an await: `createAgentNode` is a synchronous factory (it returns a node the
// canvas mounts immediately), and grok's constraint has to be answered at the moment the id is
// minted. Same shape as `permissionMode.ts`'s caps memo and `projectLaunchInfo.ts`'s per-project
// one, for the same reason both give: nothing renders off this.
//
// SELF-WARMING, and the first mint in a fresh cwd is deliberately unwarmed. An unwarmed cwd answers
// "nothing taken", which is exactly today's behaviour — mint a v4 uuid and go — and the fetch it
// kicks off means the NEXT node in that cwd is checked for real. That is the honest trade: this
// exists to stop a node reusing an id from an earlier session on disk, not to defend against a v4
// collision, and defending the first mint too would mean making node creation async everywhere.
const taken = new Map<string, Set<string>>()
const inFlight = new Map<string, Promise<void>>()

/** Ask the shell, once per cwd. Never rejects: a failed read leaves the cwd unwarmed, which reads as
 *  "nothing taken" — mint freely — rather than costing the node its id. */
export function ensureGrokTakenIds(cwd: string): Promise<void> {
  if (!cwd) return Promise.resolve()
  const existing = inFlight.get(cwd)
  if (existing) return existing
  const p = Promise.resolve()
    .then(() => window.nodeTerminal.grok.takenSessionIds(cwd))
    .then((ids) => {
      taken.set(cwd, new Set(Array.isArray(ids) ? ids : []))
    })
    .catch(() => {
      // Leave it unwarmed on purpose: an entry of "nothing taken" cached after a FAILED read would
      // look identical to a real empty answer and never be retried.
      inFlight.delete(cwd)
    })
  inFlight.set(cwd, p)
  return p
}

/** What is known right now for this cwd. An unwarmed cwd is an empty set — see the module doc. */
export function grokTakenIdsNow(cwd: string): ReadonlySet<string> {
  return taken.get(cwd) ?? new Set()
}

/** Test seam. */
export function resetGrokTakenIdsForTests(): void {
  taken.clear()
  inFlight.clear()
}
