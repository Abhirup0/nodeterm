// Single source of truth for agent launch behavior and capabilities.
// Design: an open AgentId string, a declarative config record, and
// capabilities expressed as const membership lists (not a capability object).

export type BuiltinAgentId = 'claude' | 'codex' | 'gemini'
// Open type — custom agents are any string ('custom:<uuid>'). Never restrict the set.
export type AgentId = BuiltinAgentId | (string & {})

export type PromptInjectionMode = 'argv' | 'flag-prompt' | 'stdin-after-start'

export interface AgentConfig {
  label: string // menu + node title, e.g. 'Claude Code'
  color: string // node color
  launchCmd: string // base launch command
  promptInjectionMode: PromptInjectionMode
  expectedProcess: string
}

export const BUILTIN_AGENT_IDS: readonly BuiltinAgentId[] = ['claude', 'codex', 'gemini']

export const AGENT_CONFIG: Record<BuiltinAgentId, AgentConfig> = {
  claude: {
    label: 'Claude Code',
    color: '#d97757',
    launchCmd: 'claude',
    promptInjectionMode: 'argv',
    expectedProcess: 'claude'
  },
  codex: {
    label: 'Codex',
    color: '#10a37f',
    launchCmd: 'codex',
    promptInjectionMode: 'argv',
    expectedProcess: 'codex'
  },
  gemini: {
    label: 'Gemini',
    color: '#4285f4',
    launchCmd: 'gemini',
    promptInjectionMode: 'stdin-after-start',
    expectedProcess: 'gemini'
  }
}

// Capabilities = const membership lists. A custom agent is in no list, so it
// automatically gets only spawn + terminal-title + process status.
export const AGENT_HOOK_TARGETS = ['claude', 'codex', 'gemini'] as const
export const RESUMABLE_AGENTS = ['claude', 'codex', 'gemini'] as const
export const SUBAGENT_CAPABLE = ['claude'] as const
export const RECURRING_CAPABLE = ['claude'] as const // /loop, /schedule, /cron
export const BRANCH_CAPABLE = ['claude'] as const
export const CONTEXT_LINK_CAPABLE = ['claude', 'codex', 'gemini'] as const
export const USAGE_CAPABLE = ['claude'] as const
// Agents whose structured transcript we can render as a chat panel (Cmd+M chat mode).
export const CHAT_CAPABLE = ['claude'] as const
// Agents whose native transcript we can read + render for cross-agent transfer.
export const TRANSFER_SOURCE_CAPABLE = ['claude', 'codex', 'gemini'] as const
// Agents that support naming the session in two directions: they emit a session title we adopt
// into the node title, and accept `/rename <name>` to push a renamed node title back. Claude-only.
export const RENAME_CAPABLE = ['claude'] as const
// Agents allowed to drive the canvas via the `nodeterm` CLI (open/show/write/close).
// Discovery differs per agent: claude gets the manage-nodeterm-canvas skill, codex/gemini a
// marker block in ~/.codex/AGENTS.md / ~/.gemini/GEMINI.md (see canvas-control.ts).
export const CANVAS_CONTROL_CAPABLE = ['claude', 'codex', 'gemini'] as const
// Agents whose session start-up permission mode we can set (see AgentPermissionMode below).
// Only claude's flag surface is verified. codex (--ask-for-approval) and gemini
// (--approval-mode) join by being added here with their own flag mapping.
export const PERMISSION_MODE_CAPABLE = ['claude'] as const

const includes = (list: readonly string[], id: AgentId): boolean => list.includes(id)

export const hasHooks = (id: AgentId): boolean => includes(AGENT_HOOK_TARGETS, id)
export const canResume = (id: AgentId): boolean => includes(RESUMABLE_AGENTS, id)
export const canSubagent = (id: AgentId): boolean => includes(SUBAGENT_CAPABLE, id)
export const canRecur = (id: AgentId): boolean => includes(RECURRING_CAPABLE, id)
export const canBranch = (id: AgentId): boolean => includes(BRANCH_CAPABLE, id)
export const canContextLink = (id: AgentId): boolean => includes(CONTEXT_LINK_CAPABLE, id)
export const hasUsage = (id: AgentId): boolean => includes(USAGE_CAPABLE, id)
export const canChat = (id: AgentId): boolean => includes(CHAT_CAPABLE, id)
export const canTransferFrom = (id: AgentId): boolean => includes(TRANSFER_SOURCE_CAPABLE, id)
export const canRename = (id: AgentId): boolean => includes(RENAME_CAPABLE, id)
export const canControlCanvas = (id: AgentId): boolean => includes(CANVAS_CONTROL_CAPABLE, id)
export const hasPermissionMode = (id: AgentId): boolean => includes(PERMISSION_MODE_CAPABLE, id)

// Returns the builtin config for an id, or undefined for custom/unknown agents.
export const agentConfig = (id: AgentId): AgentConfig | undefined =>
  (AGENT_CONFIG as Record<string, AgentConfig>)[id]

// Session ids are interpolated into a shell command line (written into the live shell on a
// cold restart), so accept only the safe charset agents actually use (UUIDs etc.) — never a
// flag-like or metacharacter-bearing value.
const SAFE_SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

/**
 * The command that resumes a resumable agent's prior conversation by its provider session id.
 * Used on a cold restart (machine reboot) where the tmux session — and the live agent — are
 * gone, so the conversation must be reconstructed via the agent CLI's own `--resume`.
 * Returns null for non-resumable/custom agents or an unsafe/empty session id.
 */
export function resumeCommand(id: AgentId, sessionId: string): string | null {
  if (!canResume(id)) return null
  const sid = sessionId.trim()
  if (!sid || !SAFE_SESSION_ID.test(sid)) return null
  switch (id) {
    case 'codex':
      return `codex resume ${sid}`
    case 'claude':
    case 'gemini':
      return `${id} --resume ${sid}`
    default:
      return null
  }
}

/**
 * The permission mode an agent session STARTS in. The user can still cycle modes at runtime
 * with Shift+Tab — this only decides the starting state, which is exactly what the CLI's
 * `--permission-mode` flag does.
 *
 * `dontAsk` is deliberately not exposed: from the user's point of view it overlaps `auto`.
 */
export type AgentPermissionMode = 'manual' | 'auto' | 'acceptEdits' | 'plan' | 'bypassPermissions'

// Declared first: its `Record<AgentPermissionMode, string>` type forces every member of the
// union to be present, which is what makes ALL_PERMISSION_MODES below impossible to desync.
export const PERMISSION_MODE_LABELS: Record<AgentPermissionMode, string> = {
  manual: 'Ask each time',
  auto: 'Auto',
  acceptEdits: 'Accept edits',
  plan: 'Plan',
  bypassPermissions: 'Bypass all'
}

// Derived, never hand-maintained: add a mode to the union and the compiler makes you label it,
// which lands it here (and so in the settings dropdown + isPermissionMode) automatically.
export const ALL_PERMISSION_MODES: readonly AgentPermissionMode[] = Object.keys(
  PERMISSION_MODE_LABELS
) as AgentPermissionMode[]

/** Fallback whenever a persisted mode is missing or unrecognized. */
export const DEFAULT_PERMISSION_MODE: AgentPermissionMode = 'auto'

const isPermissionMode = (v: unknown): v is AgentPermissionMode =>
  typeof v === 'string' && (ALL_PERMISSION_MODES as readonly string[]).includes(v)

/** CLI flags for a mode. `manual` yields NO flags, so the command stays bare — the exact
 *  command nodeterm shipped before this setting existed.
 *
 *  The mode is re-validated HERE even though the parameter is typed: AgentPermissionMode is
 *  compile-time only, and the value comes from hand-editable, git-shared JSON (settings.json /
 *  project.json) before being interpolated into a shell command line. Same rule as
 *  SAFE_SESSION_ID above — validate at the interpolation site. An unrecognized mode yields the
 *  safe bare command rather than a flag carrying an unvalidated value. */
export function permissionModeFlag(mode: AgentPermissionMode): string[] {
  if (!isPermissionMode(mode) || mode === 'manual') return []
  return ['--permission-mode', mode]
}

/** Appends the permission-mode flag to a launch command, if the agent supports one. The single
 *  funnel for every CLI launch path (new node, cold-restore resume, branch). */
export function withPermissionMode(cmd: string, id: AgentId, mode: AgentPermissionMode): string {
  if (!hasPermissionMode(id)) return cmd
  const flags = permissionModeFlag(mode)
  return flags.length ? `${cmd} ${flags.join(' ')}` : cmd
}

/**
 * The mode a new session starts in: the project override, else the global setting.
 * Mirrors resolveNewNodeAccount's shape, including its stale-value guard — an unrecognized
 * persisted mode must never reach the CLI as a flag value.
 *
 * Structurally typed (not `Project`/`Settings`) because src/shared/types.ts imports THIS file;
 * importing it back would be a cycle.
 */
export function resolvePermissionMode(
  project: { defaultPermissionMode?: AgentPermissionMode } | undefined,
  settings: { claudePermissionMode: AgentPermissionMode }
): AgentPermissionMode {
  if (isPermissionMode(project?.defaultPermissionMode)) return project.defaultPermissionMode
  if (isPermissionMode(settings.claudePermissionMode)) return settings.claudePermissionMode
  return DEFAULT_PERMISSION_MODE
}
