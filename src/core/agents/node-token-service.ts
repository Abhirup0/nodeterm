import { hookServer } from './hook-server'
import { nodeAuthToken, isSafeNodeId } from './node-auth-token'
import { writeNodeTokenFile, sweepNodeTokenFile } from './node-token-files'

type Canvases = () => Array<{ nodes: Array<{ id: string }> }>
let canvases: Canvases = () => []

/**
 * The token FILENAME has to stay the bare node id: the client is `sh` + `curl`, it holds only
 * `$NODETERM_NODE_ID`, and it cannot hash. That makes the filesystem's own name-equality part of
 * this scheme's trust model — and on APFS (the primary desktop target) `Term-1` and `term-1` are
 * ONE inode while `isSafeNodeId` calls them two different nodes.
 *
 * A hostile `project.json` (they travel in shared/cloned repos) can therefore put both ids on one
 * canvas and choose, by array order, whose token lands in the shared file last. The loser reads the
 * winner's token and POSTs as the winner ⇒ `verified` as a node it does not own. Reverse the order
 * and the victim reads a token minted for the ATTACKER's id ⇒ its own posts verdict `forged` ⇒ 403
 * on /hook/*, and the managed script's `curl -sS` has no `--fail`, so a 403 exits 0, no failover
 * fires, and the node goes silently dark for the life of the session.
 *
 * So: detect the collision at MATERIALISATION and write NONE of the colliding set — plus sweep any
 * file an earlier (pre-collision) pass already wrote for them, because leaving that one in place is
 * exactly the attack. Refusing means those nodes fall back to `legacy`, which is the designed
 * fail-open state, not an outage. Validating at node-CREATION time cannot work: the file arrives
 * pre-written from the repo, no creation path is involved.
 */

/**
 * NFC first, then a full Unicode lower-case.
 *
 * Today `NODE_ID_CHARSET` is ASCII-only, so `toLowerCase()` alone would be exact and the NFC pass
 * is a no-op. It is here anyway because the asymmetry of the two mistakes is total: a FALSE
 * collision costs those nodes nothing but a drop to `legacy` (the fail-open state the whole series
 * is built around), while a MISSED collision is the vulnerability above. APFS folds Unicode case
 * AND is normalization-insensitive, so if the charset ever widens, the key must already cover both
 * — and `toLowerCase()` is broader than APFS's own fold table, which errs in the safe direction.
 */
export function nodeIdFoldKey(id: string): string {
  return id.normalize('NFC').toLowerCase()
}

/**
 * Map every id that shares a fold key with a DIFFERENT id to its whole colliding group. Exact
 * duplicates are not a collision — two canvas entries with the identical id write identical bytes
 * to one file, which is a no-op, not a hijack — so the ids are de-duplicated first. Unsafe ids are
 * dropped up front: they never reach a path join, so they cannot own a file to collide over.
 * Members of one group share ONE array instance, so callers can de-duplicate groups by identity.
 */
function collidingGroups(ids: Iterable<string>): Map<string, string[]> {
  const byKey = new Map<string, string[]>()
  for (const id of new Set(ids)) {
    if (!isSafeNodeId(id)) continue
    const key = nodeIdFoldKey(id)
    const group = byKey.get(key)
    if (group) group.push(id)
    else byKey.set(key, [id])
  }
  const colliding = new Map<string, string[]>()
  for (const group of byKey.values())
    if (group.length > 1) for (const id of group) colliding.set(id, group)
  return colliding
}

/** Loud on purpose: this is the only signal that a node is on `legacy` for a reason. */
function warnCollision(group: readonly string[]): void {
  console.warn(
    '[node-identity] refusing per-node tokens: these node ids collide when case-folded and would ' +
      `share one file on a case-insensitive filesystem — ${group.join(', ')}`
  )
}

function canvasNodeIds(): string[] {
  const ids: string[] = []
  for (const c of canvases()) for (const n of c.nodes ?? []) ids.push(n.id)
  return ids
}

function materialiseOne(secret: Buffer, nodeId: string): void {
  const token = nodeAuthToken(secret, nodeId)
  if (token) writeNodeTokenFile(nodeId, token)
}

/**
 * The BOOT SWEEP is what makes this upgrade invisible: it writes a token for every node id in every
 * persisted project, so a session that has been running since before the upgrade becomes verified
 * at its NEXT hook event, with no restart and no user action. A few hundred tiny files is the whole
 * cost. Without it, the migration warning window would be the only path and every running node
 * would spend it unverified.
 */
export function initNodeTokens(deps: { canvases: Canvases }): void {
  canvases = deps.canvases
  refreshNodeTokens()
}

export function ensureNodeToken(nodeId: string): void {
  const secret = hookServer.nodeAuthSecretOrNull()
  if (!secret) return // legacy everywhere, write nothing
  // The spawn path must apply the same refusal as the sweep, or a hostile pair would simply be
  // written one node at a time. `nodeId` joins the canvas set because a node can be spawned before
  // its canvas has been persisted.
  const group = collidingGroups([...canvasNodeIds(), nodeId]).get(nodeId)
  if (group) {
    warnCollision(group)
    for (const id of group) sweepNodeTokenFile(id)
    return
  }
  materialiseOne(secret, nodeId)
}

export function sweepNodeToken(nodeId: string): void {
  sweepNodeTokenFile(nodeId)
}

export function refreshNodeTokens(): void {
  const secret = hookServer.nodeAuthSecretOrNull()
  if (!secret) return
  const ids = canvasNodeIds()
  const colliding = collidingGroups(ids)
  for (const group of new Set(colliding.values())) {
    warnCollision(group)
    // Sweep, don't merely skip: an earlier pass may have written one of these before its twin
    // appeared on the canvas, and that surviving file is the token the twin would read.
    for (const id of group) sweepNodeTokenFile(id)
  }
  for (const id of new Set(ids)) {
    if (colliding.has(id)) continue
    materialiseOne(secret, id)
  }
}
