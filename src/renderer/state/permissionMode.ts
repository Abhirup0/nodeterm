import { gatePermissionMode, resolvePermissionMode, type AgentPermissionMode } from '@shared/agents/config'
import { UNKNOWN_CLAUDE_CLI_CAPS, type ClaudeCliCaps, type Project } from '@shared/types'
import { useProjects } from './projects'
import { useSettings } from './settings'
import { useSshConn } from './sshConn'

/**
 * Local Claude CLI capabilities, probed once per app run through `claude.cliCaps()` (main/server →
 * core/claude-cli.ts). Kept as a module-level memo rather than a zustand store: nothing renders
 * from it — it is read only at the moment a launch command is built — and a store would invite
 * re-renders on a value that never changes while the app runs.
 *
 * Until the probe answers, `caps` is the FAIL-OPEN unknown: no `auto` flag, i.e. the bare `claude`
 * command. A launch is never blocked on the probe.
 */
let caps: ClaudeCliCaps = UNKNOWN_CLAUDE_CLI_CAPS
let capsPromise: Promise<ClaudeCliCaps> | null = null

/** Kick off (or join) the local CLI probe. Never rejects. Called once at boot; awaited by any
 *  launch path that can run before boot settles (a cold-restored agent node). */
export function ensureClaudeCliCaps(): Promise<ClaudeCliCaps> {
  if (!capsPromise) {
    capsPromise = Promise.resolve()
      .then(() => window.nodeTerminal.claude.cliCaps())
      .then((c) => (caps = c ?? UNKNOWN_CLAUDE_CLI_CAPS))
      .catch(() => UNKNOWN_CLAUDE_CLI_CAPS)
  }
  return capsPromise
}

/** Test seam: drop the memo (and optionally preload a known answer). */
export function resetClaudeCliCapsForTests(next?: ClaudeCliCaps): void {
  caps = next ?? UNKNOWN_CLAUDE_CLI_CAPS
  capsPromise = null
}

/**
 * Does the CLI that will actually RUN this project's sessions accept `--permission-mode auto`?
 *
 * An SSH project's terminals run on the remote host, whose claude can be OLDER than the local one
 * — so the local probe's answer is never applied to a remote launch. The remote is probed on its
 * own host at connect (SshProjectManager) and cached in `useSshConn`; not connected / not yet
 * probed / older CLI all answer false, which omits the flag (conservative, and exactly the
 * command nodeterm shipped before this setting existed).
 */
function autoSupportedFor(project: Project | undefined): boolean {
  if (project?.ssh) return useSshConn.getState().supportsAutoPermissionMode(project.id)
  return caps.autoPermissionMode
}

/**
 * The permission mode a session launched RIGHT NOW actually starts in: the active project's
 * override, else the global setting — with `auto` degraded to `manual` (no flag → bare command)
 * when the CLI that will run it is too old to know the value (Claude Code < 2.1.71, which exits 1
 * on it) or hasn't been probed yet. The other four modes are never touched by the gate.
 *
 * Lives in its own module rather than in workspace.ts because projects.ts imports workspace.ts
 * (createProject) — importing the projects store from workspace.ts would close that cycle.
 */
export function activePermissionMode(): AgentPermissionMode {
  const { settings } = useSettings.getState()
  const { getProject, activeProjectId } = useProjects.getState()
  const project = getProject(activeProjectId)
  return gatePermissionMode(resolvePermissionMode(project, settings), autoSupportedFor(project))
}

/**
 * `activePermissionMode()` for callers that can run BEFORE the boot-time probe has answered — the
 * cold-restore agent relaunch fires on node mount. Awaiting the (memoized, warmed in the shell)
 * probe there means a rebooted machine still gets `auto`, instead of silently falling back to the
 * bare command for one session.
 */
export async function ensureActivePermissionMode(): Promise<AgentPermissionMode> {
  await ensureClaudeCliCaps()
  return activePermissionMode()
}
