// Connection-time remote hook setup for SSH projects: opens the reverse unix-socket tunnel
// (local loopback hook server → remote socket), writes the owner-only remote endpoint file,
// and installs the managed hook into the remote agent configs (claude + gemini in Phase 2a;
// codex deferred). Every step fails open: any remote failure → setup returns null and the
// agent simply runs without hooks. Takes an INJECTED runner so the flow is unit-testable
// without real ssh/electron.
import { childArgs, hookForwardArgs, hookForwardCancelArgs, remoteEndpointFileContents } from './control-master'
import { buildManagedScript } from '../agents/hooks/managed-script'
import { mergeManagedHook, type HookSettings } from '../agents/hooks/install-helper'
import type { SshConnection } from '../../shared/ssh'

export interface RemoteRunner {
  /** Run one ssh child command (over the master); optional stdin written to the child. */
  run: (args: string[], stdin?: string) => Promise<{ code: number; stdout: string }>
}

// Per-agent remote install targets (JSON-config agents only in Phase 2a; codex deferred).
const REMOTE_DIR = '~/.nodeterm'
const AGENT_TARGETS: { agentId: string; config: string; script: string; events: string[] }[] = [
  {
    agentId: 'claude',
    config: '~/.claude/settings.json',
    script: `${REMOTE_DIR}/agent-hooks/claude.sh`,
    events: ['Stop', 'Notification', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'SubagentStop']
  },
  {
    agentId: 'gemini',
    config: '~/.gemini/settings.json',
    script: `${REMOTE_DIR}/agent-hooks/gemini.sh`,
    events: ['Stop', 'Notification', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']
  }
]

const REMOTE_SOCK = (projectId: string): string => `${REMOTE_DIR}/hook-${projectId}.sock`
const REMOTE_ENDPOINT = `${REMOTE_DIR}/hook-endpoint.env`

export class RemoteHooks {
  // Remember the hook port used at setup per project so teardown cancels the exact `-R` spec.
  private ports = new Map<string, number>()

  constructor(private r: RemoteRunner) {}

  async setup(
    projectId: string,
    conn: SshConnection,
    controlPath: string,
    hook: { port: number; token: string; version: string }
  ): Promise<{ endpointPath: string } | null> {
    if (!hook.port || !hook.token) return null
    const sock = REMOTE_SOCK(projectId)
    try {
      // 1. reverse unix-socket forward (stale socket → remove first so -R can bind).
      await this.r.run(childArgs(conn, controlPath, `mkdir -p ${REMOTE_DIR} && rm -f ${sock}`))
      await this.r.run(hookForwardArgs(conn, controlPath, sock, hook.port))
      this.ports.set(projectId, hook.port)
      // 2. remote endpoint file (0600 via umask).
      await this.r.run(
        childArgs(conn, controlPath, `umask 077; cat > ${REMOTE_ENDPOINT}`),
        remoteEndpointFileContents(sock, hook.token, hook.version)
      )
      // 3. install the managed hook for each JSON agent (script + merged config).
      for (const t of AGENT_TARGETS) {
        await this.r.run(
          childArgs(conn, controlPath, `mkdir -p ${REMOTE_DIR}/agent-hooks && cat > ${t.script} && chmod 755 ${t.script}`),
          buildManagedScript(t.agentId)
        )
        const { stdout } = await this.r.run(childArgs(conn, controlPath, `cat ${t.config} 2>/dev/null || echo '{}'`))
        let cfg: HookSettings = {}
        try {
          cfg = JSON.parse(stdout || '{}') as HookSettings
        } catch {
          cfg = {}
        }
        const merged = mergeManagedHook(cfg, `sh "${t.script}"`, t.events)
        await this.r.run(
          childArgs(conn, controlPath, `mkdir -p $(dirname ${t.config}) && cat > ${t.config}`),
          JSON.stringify(merged, null, 2)
        )
      }
      return { endpointPath: REMOTE_ENDPOINT }
    } catch {
      return null // fail-open: agent runs without hooks
    }
  }

  async teardown(projectId: string, conn: SshConnection, controlPath: string): Promise<void> {
    const port = this.ports.get(projectId) ?? 0
    this.ports.delete(projectId)
    try {
      await this.r.run(hookForwardCancelArgs(conn, controlPath, REMOTE_SOCK(projectId), port))
    } catch {
      /* fail open */
    }
  }
}
