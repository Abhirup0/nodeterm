// Connection-time remote hook setup for SSH projects: opens the reverse unix-socket tunnel
// (local loopback hook server → remote socket), writes the owner-only remote endpoint file,
// and installs the managed hook into the remote agent configs (claude + gemini in Phase 2a;
// codex deferred). Every step fails open: any remote failure → setup returns null and the
// agent simply runs without hooks. Takes an INJECTED runner so the flow is unit-testable
// without real ssh/electron.
import { childArgs, hookForwardArgs, hookForwardCancelArgs, remoteEndpointFileContents } from '../../core/remote-ssh/control-master'
import { buildManagedScript } from '../../core/agents/hooks/managed-script'
import { mergeManagedHook, type HookSettings } from '../../core/agents/hooks/install-helper'
import { ensureFullscreenTui, type TuiSettings } from '../../core/agents/hooks/claude-tui'
import { posixQuote, type SshConnection } from '../../shared/ssh'

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

  /**
   * Merge the managed claude hook into a REMOTE managed-account config dir's `settings.json`, so an
   * agent that runs under `CLAUDE_CONFIG_DIR=<accountDir>` reports status like the default
   * `~/.claude` does (badges / notifications / subagent viz). The claude CLI reads its hooks from
   * `$CLAUDE_CONFIG_DIR/settings.json`, so `setup()`'s merge into `~/.claude/settings.json` does NOT
   * cover account sessions — this fills the gap. Reuses the same hook SCRIPT `setup()` wrote (writing
   * it idempotently in case setup didn't run) + the shared merge helper, preserving any hooks the
   * account dir already has. `remoteHome` is the resolved remote `$HOME`; every path is absolute
   * (a literal `~` inside the merged `sh "…"` command would not expand). Fail-open.
   */
  async installIntoAccountDir(
    conn: SshConnection,
    controlPath: string,
    remoteHome: string,
    accountId: string
  ): Promise<void> {
    try {
      const remoteDir = `${remoteHome}/.nodeterm`
      const script = `${remoteDir}/agent-hooks/claude.sh`
      const accountDir = `${remoteHome}/.nodeterm/claude-accounts/${accountId}`
      const config = `${accountDir}/settings.json`
      const events = AGENT_TARGETS.find((t) => t.agentId === 'claude')?.events ?? []
      // Idempotently (re)write the shared hook script — setup() may not have run (fail-open) yet.
      await this.r.run(
        childArgs(conn, controlPath, `mkdir -p ${posixQuote(`${remoteDir}/agent-hooks`)} && cat > ${posixQuote(script)} && chmod 755 ${posixQuote(script)}`),
        buildManagedScript('claude')
      )
      const { stdout: cfgRaw } = await this.r.run(
        childArgs(conn, controlPath, `cat ${posixQuote(config)} 2>/dev/null || echo '{}'`)
      )
      let cfg: HookSettings = {}
      try {
        cfg = JSON.parse(cfgRaw || '{}') as HookSettings
      } catch {
        cfg = {}
      }
      const merged = mergeManagedHook(cfg, `sh "${script}"`, events)
      await this.r.run(
        childArgs(conn, controlPath, `mkdir -p ${posixQuote(accountDir)} && cat > ${posixQuote(config)}`),
        JSON.stringify(merged, null, 2)
      )
    } catch {
      /* fail-open: the account session simply runs without status hooks */
    }
  }

  /**
   * Ensure `"tui": "fullscreen"` in the REMOTE host's `~/.claude/settings.json` — write-if-absent,
   * so a remote Claude session takes the alternate screen + mouse and behaves natively in the
   * host's tmux. The CALLER gates this on the host CLI being >= 2.1.89 (the remote `claude --version`
   * already cached on the connection — no second probe). `remoteHome` is the resolved remote `$HOME`
   * so the path is absolute (a literal `~` would not expand). Fail-open.
   */
  async ensureFullscreenTui(conn: SshConnection, controlPath: string, remoteHome: string): Promise<void> {
    await this.ensureFullscreenTuiAt(conn, controlPath, `${remoteHome}/.claude/settings.json`)
  }

  /** Same guardrails, for a REMOTE managed-account config dir's `settings.json`. */
  async ensureFullscreenTuiInAccountDir(
    conn: SshConnection,
    controlPath: string,
    remoteHome: string,
    accountId: string
  ): Promise<void> {
    const config = `${remoteHome}/.nodeterm/claude-accounts/${accountId}/settings.json`
    await this.ensureFullscreenTuiAt(conn, controlPath, config)
  }

  /** Read-merge-write the fullscreen-tui key at one absolute remote config path, over the master.
   *  Same read-if-present, write-only-if-changed, fail-open mechanics as the hook merge above. */
  private async ensureFullscreenTuiAt(conn: SshConnection, controlPath: string, config: string): Promise<void> {
    try {
      const { stdout: raw } = await this.r.run(
        childArgs(conn, controlPath, `cat ${posixQuote(config)} 2>/dev/null || echo '{}'`)
      )
      let cfg: TuiSettings = {}
      try {
        cfg = JSON.parse(raw || '{}') as TuiSettings
      } catch {
        cfg = {}
      }
      const { config: next, changed } = ensureFullscreenTui(cfg)
      if (!changed) return // key already present (any value) → never overwrite the user's `/tui`
      await this.r.run(
        childArgs(conn, controlPath, `mkdir -p $(dirname ${posixQuote(config)}) && cat > ${posixQuote(config)}`),
        JSON.stringify(next, null, 2)
      )
    } catch {
      /* fail-open: a failed remote read/write must never break the connect */
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
