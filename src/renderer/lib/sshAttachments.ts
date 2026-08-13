import { sshConnectionIdForProject, sshHostKey, type SshConnection } from '@shared/ssh'

/** One host a project's canvas has REMOTE nodes on, other than the project's own endpoint. */
export interface HostAttachment {
  /** Connection scope: `sshAttachmentId(projectId, conn)`. Keys `useSshConn`, the ControlMaster,
   *  and the reconnect loop, exactly as an SSH project's id does for its own nodes. */
  scopeId: string
  /** `user@host` — the machine, ignoring port/identity (same remote `$HOME`). */
  hostKey: string
  conn: SshConnection
  /** The cwd the connection itself is opened with (the Explorer/scp base). The individual nodes
   *  still spawn in their OWN `cwd`; this is the first attached node's, as the representative. */
  remoteCwd?: string
  /** Node ids on this host — the connect banner and the reconnect flush work per scope. */
  nodeIds: string[]
}

/** The subset of a persisted canvas node this needs. Deliberately structural: the caller passes
 *  either persisted node states or live React Flow `data`, and both satisfy it. */
export interface AttachableNode {
  id: string
  ssh?: SshConnection
  sshRemoteTmux?: boolean
  cwd?: string
}

/**
 * Which host attachments a project's canvas needs opened.
 *
 * A remote node whose endpoint IS the project's own is served by the project's ControlMaster and
 * is not listed — that is main's whole model, and it stays untouched. Everything else is an
 * attachment: every remote node on a LOCAL project, and a node pointed at a second host inside an
 * SSH project. Grouped by scope, so one master serves every node on the same machine.
 *
 * `sshRemoteTmux` is required: a plain `ssh <host>` node (`createSshTerminalNode`) runs ssh as its
 * own local PTY program and needs no master at all — opening one for it would be a connection the
 * user never asked for.
 */
export function hostAttachmentsFor(
  projectId: string,
  nodes: readonly AttachableNode[],
  projectServer?: SshConnection
): HostAttachment[] {
  const byScope = new Map<string, HostAttachment>()
  for (const node of nodes) {
    const conn = node.ssh
    if (!conn || !node.sshRemoteTmux) continue
    const scopeId = sshConnectionIdForProject(projectId, conn, projectServer)
    if (scopeId === projectId) continue // the project's own master already serves this node
    const existing = byScope.get(scopeId)
    if (existing) existing.nodeIds.push(node.id)
    else
      byScope.set(scopeId, {
        scopeId,
        hostKey: sshHostKey(conn),
        conn,
        remoteCwd: node.cwd,
        nodeIds: [node.id]
      })
  }
  return [...byScope.values()]
}
