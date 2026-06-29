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
// Paths are relative to the remote $HOME and are made absolute once it is resolved at setup
// (a literal `~` is NOT expanded inside double quotes or when passed as data, so the merged
// hook command / endpoint file / `-R` bind path would otherwise carry an unexpanded tilde).
const AGENT_TARGETS: { agentId: string; config: string; events: string[] }[] = [
  {
    agentId: 'claude',
    config: '.claude/settings.json',
    events: ['Stop', 'Notification', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'SessionStart', 'SessionEnd', 'SubagentStop']
  },
  {
    agentId: 'gemini',
    config: '.gemini/settings.json',
    events: ['Stop', 'Notification', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse']
  }
]

export class RemoteHooks {
  // Remember the absolute sock path + hook port used at setup per project so teardown cancels
  // the exact `-R` spec (teardown does not re-resolve $HOME).
  private specs = new Map<string, { sock: string; port: number }>()

  constructor(private r: RemoteRunner) {}

  async setup(
    projectId: string,
    conn: SshConnection,
    controlPath: string,
    hook: { port: number; token: string; version: string }
  ): Promise<{ endpointPath: string } | null> {
    if (!hook.port || !hook.token) return null
    try {
      // 0. resolve the remote $HOME once → build all remote paths absolute (no unexpanded ~).
      const { code, stdout } = await this.r.run(childArgs(conn, controlPath, 'printf %s "$HOME"'))
      const home = stdout.trim()
      if (code !== 0 || !home) return null // fail-open: nothing else would work
      const remoteDir = `${home}/.nodeterm`
      const sock = `${remoteDir}/hook-${projectId}.sock`
      const endpoint = `${remoteDir}/hook-endpoint.env`
      // 1. reverse unix-socket forward (stale socket → remove first so -R can bind).
      await this.r.run(childArgs(conn, controlPath, `mkdir -p ${remoteDir} && rm -f ${sock}`))
      await this.r.run(hookForwardArgs(conn, controlPath, sock, hook.port))
      this.specs.set(projectId, { sock, port: hook.port })
      // 2. remote endpoint file (0600 via umask).
      await this.r.run(
        childArgs(conn, controlPath, `umask 077; cat > ${endpoint}`),
        remoteEndpointFileContents(sock, hook.token, hook.version)
      )
      // 3. install the managed hook for each JSON agent (script + merged config).
      for (const t of AGENT_TARGETS) {
        const script = `${remoteDir}/agent-hooks/${t.agentId}.sh`
        const config = `${home}/${t.config}`
        await this.r.run(
          childArgs(conn, controlPath, `mkdir -p ${remoteDir}/agent-hooks && cat > ${script} && chmod 755 ${script}`),
          buildManagedScript(t.agentId)
        )
        const { stdout: cfgRaw } = await this.r.run(childArgs(conn, controlPath, `cat ${config} 2>/dev/null || echo '{}'`))
        let cfg: HookSettings = {}
        try {
          cfg = JSON.parse(cfgRaw || '{}') as HookSettings
        } catch {
          cfg = {}
        }
        const merged = mergeManagedHook(cfg, `sh "${script}"`, t.events)
        await this.r.run(
          childArgs(conn, controlPath, `mkdir -p $(dirname ${config}) && cat > ${config}`),
          JSON.stringify(merged, null, 2)
        )
      }
      return { endpointPath: endpoint }
    } catch {
      return null // fail-open: agent runs without hooks
    }
  }

  async teardown(projectId: string, conn: SshConnection, controlPath: string): Promise<void> {
    const spec = this.specs.get(projectId)
    this.specs.delete(projectId)
    if (!spec) return // nothing was set up (or already torn down)
    try {
      await this.r.run(hookForwardCancelArgs(conn, controlPath, spec.sock, spec.port))
    } catch {
      /* fail open */
    }
  }
}
