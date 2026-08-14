import { hookServer } from './hook-server'
import { nodeAuthToken } from './node-auth-token'
import { writeNodeTokenFile, sweepNodeTokenFile } from './node-token-files'

type Canvases = () => Array<{ nodes: Array<{ id: string }> }>
let canvases: Canvases = () => []

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
  const token = nodeAuthToken(secret, nodeId)
  if (token) writeNodeTokenFile(nodeId, token)
}

export function sweepNodeToken(nodeId: string): void {
  sweepNodeTokenFile(nodeId)
}

export function refreshNodeTokens(): void {
  const secret = hookServer.nodeAuthSecretOrNull()
  if (!secret) return
  for (const c of canvases()) for (const n of c.nodes ?? []) ensureNodeToken(n.id)
}
