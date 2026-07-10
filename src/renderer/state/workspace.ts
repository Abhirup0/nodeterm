import type { Node } from '@xyflow/react'
import type { CanvasMutation, CanvasNodeState, ClaudeAccount, NodeKind, Project } from '@shared/types'
import type { AgentId } from '@shared/agents/config'
import { agentConfig } from '@shared/agents/config'
import { sshHostKey } from '@shared/ssh'
import { useSettings } from './settings'

/** Preset color palette — macOS system colors (dark mode). */
export const NODE_COLORS = [
  '#0a84ff', // systemBlue
  '#32d74b', // systemGreen
  '#ffd60a', // systemYellow
  '#ff453a', // systemRed
  '#bf5af2', // systemPurple
  '#6ac4dc', // systemTeal
  '#ff9f0a' // systemOrange
]

const TERMINAL_SIZE = { width: 600, height: 400 }
const STICKY_SIZE = { width: 240, height: 200 }
const GROUP_SIZE = { width: 520, height: 360 }
const EDITOR_SIZE = { width: 660, height: 460 }
const DIFF_SIZE = { width: 860, height: 500 }
const DINO_SIZE = { width: 600, height: 200 }
const VIDEO_SIZE = { width: 640, height: 420 }
const WEB_SIZE = { width: 720, height: 520 }
const BROWSER_SIZE = { width: 800, height: 560 }
const CHAT_SIZE = { width: 420, height: 380 }

/** Height of a node when collapsed (header only). */
export const COLLAPSED_HEIGHT = 40

/** User data carried in the React Flow node's data field. */
export interface NodeData {
  title: string
  /**
   * Agent nodes only: while true (the default for agent nodes), the title auto-tracks the
   * agent's session name (see TerminalNode's onTitleChange). Flipped to false the moment the
   * user renames the node by hand — then the user's name is pushed back via `/rename`.
   */
  titleAuto?: boolean
  color: string
  group: string | null
  tags?: string[]
  collapsed?: boolean
  /** Expanded height to restore when un-collapsing (kept out of the persisted size). */
  expandedHeight?: number
  /** One-shot command run once when the terminal first opens (not persisted). */
  initialCommand?: string
  /**
   * Transient respawn trigger: bumping this number tears down a terminal node's session and
   * recreates it (used to move an existing terminal into a worktree cwd). Not persisted —
   * deliberately absent from flowToNodeStates, like initialCommand/expandedHeight.
   */
  respawnNonce?: number
  shell?: string
  cwd?: string
  text?: string
  filePath?: string
  /** web-only: live URL to load in the web (webview) node. */
  url?: string
  diffStaged?: boolean
  commitOid?: string
  /** dino-only: best score reached in the T-Rex Runner game. */
  highScore?: number
  /** Which agent runs in this terminal node (claude/codex/gemini/custom). */
  agentId?: AgentId
  /**
   * Claude nodes only: the managed Claude account (config-dir isolated) this node runs under.
   * Persisted so cold-restore resume reads the transcript from the right account dir.
   */
  accountId?: string
  /** group-only: the git worktree this group is bound to (single source of truth). */
  worktree?: import('@shared/worktree').GroupWorktree
  /**
   * When set, this terminal runs on a REMOTE host over the relay (RemoteTransport) rather than
   * the local PTY (LocalTransport). Not persisted — remote nodes are transient to a live
   * connection (see flowToNodeStates).
   */
  remote?: { connectionId: string }
  /**
   * When set, this terminal runs `ssh` to a remote host on the LOCAL PTY (LocalTransport).
   * Unlike `remote` (relay), this IS persisted — the node auto-reconnects on relaunch.
   */
  ssh?: import('@shared/ssh').SshConnection
  /**
   * When true (SSH-project terminals), this node runs in REMOTE tmux on the host in `ssh`
   * (LocalTransport passes `sshRemote` to the PTY), rather than plain `ssh`-on-local-PTY. Persisted.
   */
  sshRemoteTmux?: boolean
  /**
   * editor-only: when true (an editor created in an SSH project), reads/writes/image-previews go to
   * the project's REMOTE filesystem via `sshFs(projectId)` instead of the local fs. Persisted, so an
   * SSH-project editor still routes to the remote fs after reopen.
   */
  sshFs?: boolean
  /**
   * chat-only: the SDK session id of this chat node's conversation. Persisted so a relaunch
   * resumes the on-disk transcript (the SDK process dies with the app).
   */
  chatSessionId?: string
  /**
   * chat-only: source session id to fork from on first boot (Task 10). One-shot bootstrap —
   * NOT persisted (like initialCommand); once the node's own chatSessionId arrives it's ignored.
   */
  forkFrom?: string
  [key: string]: unknown
}

/** React Flow node type string mirrors the persisted NodeKind. */
export type CanvasNode = Node<NodeData, NodeKind>

/** Single-quote a string for safe use as one shell argument (POSIX). */
export function shellSingleQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`
}

let idCounter = 0
function nextId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${++idCounter}`
}

/** Stagger placement so new nodes don't overlap. */
function staggeredPosition(index: number) {
  return { x: 80 + (index % 4) * 360, y: 120 + Math.floor(index / 4) * 320 }
}

/** Top-left position so a node of the given size is centered on `center`. */
function placeAt(center: { x: number; y: number } | undefined, index: number, w: number, h: number) {
  return center ? { x: center.x - w / 2, y: center.y - h / 2 } : staggeredPosition(index)
}

/**
 * Creates a new terminal node. `cwd` comes from the active project's default folder. When `ssh`
 * (the active SSH project's binding) is given, the node runs in REMOTE tmux on that host: its
 * `data.ssh`/`data.sshRemoteTmux`/`data.cwd` are stamped from the binding instead of `cwd`.
 */
export function createTerminalNode(
  index: number,
  cwd?: string,
  center?: { x: number; y: number },
  initialCommand?: string,
  ssh?: Project['ssh']
): CanvasNode {
  return {
    id: nextId('term'),
    type: 'terminal',
    position: placeAt(center, index, TERMINAL_SIZE.width, TERMINAL_SIZE.height),
    width: TERMINAL_SIZE.width,
    height: TERMINAL_SIZE.height,
    style: { width: TERMINAL_SIZE.width, height: TERMINAL_SIZE.height },
    data: {
      title: `Terminal ${index + 1}`,
      color: NODE_COLORS[index % NODE_COLORS.length],
      group: null,
      tags: [],
      cwd: ssh ? ssh.remoteCwd : cwd,
      initialCommand,
      ...(ssh ? { ssh: ssh.server, sshRemoteTmux: true } : {})
    }
  }
}

/**
 * Creates a terminal node bound to a REMOTE host over the relay. Identical to a local terminal
 * except `data.remote.connectionId` is set, which makes TerminalNode pick RemoteTransport instead
 * of LocalTransport. Not persisted (see flowToNodeStates).
 */
export function createRemoteTerminalNode(
  connectionId: string,
  index: number,
  center?: { x: number; y: number }
): CanvasNode {
  return {
    id: nextId('remote'),
    type: 'terminal',
    position: placeAt(center, index, TERMINAL_SIZE.width, TERMINAL_SIZE.height),
    width: TERMINAL_SIZE.width,
    height: TERMINAL_SIZE.height,
    style: { width: TERMINAL_SIZE.width, height: TERMINAL_SIZE.height },
    data: {
      title: 'Remote terminal',
      color: NODE_COLORS[index % NODE_COLORS.length],
      group: null,
      tags: [],
      remote: { connectionId }
    }
  }
}

/**
 * Creates a terminal node that runs `ssh` to a saved server on the local PTY. The connection
 * is snapshotted inline (`data.ssh`) so the node survives the server being edited/deleted.
 */
export function createSshTerminalNode(
  server: import('@shared/ssh').SshServer,
  index: number,
  center?: { x: number; y: number }
): CanvasNode {
  return {
    id: nextId('ssh'),
    type: 'terminal',
    position: placeAt(center, index, TERMINAL_SIZE.width, TERMINAL_SIZE.height),
    width: TERMINAL_SIZE.width,
    height: TERMINAL_SIZE.height,
    style: { width: TERMINAL_SIZE.width, height: TERMINAL_SIZE.height },
    data: {
      title: server.label,
      color: NODE_COLORS[index % NODE_COLORS.length],
      group: null,
      tags: [],
      ssh: {
        host: server.host,
        user: server.user,
        port: server.port,
        identityFile: server.identityFile,
        extraArgs: server.extraArgs,
        label: server.label
      }
    }
  }
}

/**
 * Command that launches Claude Code. Detection works via hooks installed globally in
 * ~/.claude/settings.json (gated by NODETERM_* env that the PTY manager sets), so a plain
 * `claude` is enough. Append `-r <id>` to resume a specific session (used by Branch).
 */
export function claudeLaunchCommand(): string {
  return 'claude'
}

/** Fallback color for custom / unknown agents that have no config-provided color. */
const FALLBACK_AGENT_COLOR = '#888888'

/**
 * Resolves an agent's label/color/launch command. Builtins come from the static config;
 * custom agents are looked up by id in the settings store. Falls back to the id itself for
 * unknown agents so a node still spawns something sensible.
 */
function resolveAgent(agentId: AgentId): { label: string; color: string; launchCmd: string } {
  const builtin = agentConfig(agentId)
  if (builtin) return { label: builtin.label, color: builtin.color, launchCmd: builtin.launchCmd }
  const custom = useSettings.getState().settings.customAgents.find((c) => c.id === agentId)
  if (custom) return { label: custom.label, color: FALLBACK_AGENT_COLOR, launchCmd: custom.launchCmd }
  return { label: agentId, color: FALLBACK_AGENT_COLOR, launchCmd: agentId }
}

/**
 * The managed accounts selectable in a given project, host-scoped. A LOCAL project shows only
 * local accounts (no `host`); an SSH project shows only accounts whose `host` matches that
 * project's connection identity (`sshHostKey` = `user@host`). Pending (not-yet-logged-in) accounts
 * are always excluded. Keeps a project's add-menus / default-account picker from offering an
 * account that can't run there (a remote account's credentials live on its host's filesystem).
 */
export function accountsForProject(
  accounts: ClaudeAccount[],
  project: { ssh?: { server: { host: string; user: string } } } | undefined
): ClaudeAccount[] {
  const hostKey = project?.ssh ? sshHostKey(project.ssh.server) : undefined
  return accounts.filter((a) => !a.pending && (hostKey ? a.host === hostKey : !a.host))
}

/** Account for a NEW Claude node: explicit pick, else the project default, else system. */
export function resolveNewNodeAccount(
  explicit: string | undefined,
  project: { defaultAccountId?: string } | undefined,
  accounts: ClaudeAccount[]
): string | undefined {
  const id = explicit ?? project?.defaultAccountId
  // A stale default (account since removed) must not stamp dead ids onto new nodes.
  return id && accounts.some((a) => a.id === id) ? id : undefined
}

/**
 * Creates a terminal node that launches the given agent on open. Title, color, and the
 * launch command come from the resolved agent config (builtin or custom); the node carries
 * `agentId` so the rest of the app (hooks, capabilities, UI) can branch on it. For `claude`
 * we use `claudeLaunchCommand()`.
 */
export function createAgentNode(
  agentId: AgentId,
  index: number,
  cwd?: string,
  center?: { x: number; y: number },
  initialPrompt?: string,
  ssh?: Project['ssh'],
  accountId?: string
): CanvasNode {
  const { label, color, launchCmd } = resolveAgent(agentId)
  const baseCmd = agentId === 'claude' ? claudeLaunchCommand() : launchCmd
  const initialCommand = initialPrompt
    ? `${baseCmd} ${shellSingleQuote(initialPrompt.replace(/\s+/g, ' ').trim())}`
    : baseCmd
  return {
    id: nextId('term'),
    type: 'terminal',
    position: placeAt(center, index, TERMINAL_SIZE.width, TERMINAL_SIZE.height),
    width: TERMINAL_SIZE.width,
    height: TERMINAL_SIZE.height,
    style: { width: TERMINAL_SIZE.width, height: TERMINAL_SIZE.height },
    data: {
      title: label,
      // Adopt the agent's own session name into the title until the user renames it by hand.
      titleAuto: true,
      color,
      group: null,
      tags: [],
      agentId,
      // Accounts are inherently Claude-only — never stamp one onto another agent's node.
      ...(accountId && agentId === 'claude' ? { accountId } : {}),
      cwd: ssh ? ssh.remoteCwd : cwd,
      initialCommand,
      ...(ssh ? { ssh: ssh.server, sshRemoteTmux: true } : {})
    }
  }
}

/** Creates a terminal that launches Claude Code (`claude`) on open. Thin wrapper. */
export function createClaudeNode(
  index: number,
  cwd?: string,
  center?: { x: number; y: number }
): CanvasNode {
  return createAgentNode('claude', index, cwd, center)
}

/**
 * Chip text for an account-bound node header. Given a node's `accountId` and the known
 * accounts, returns the short chip label (the part of the account label before `@`, capped
 * at ~10 chars with an ellipsis) plus a tooltip (`label (email)`, or just the label when no
 * email). Returns `null` when there's no `accountId` (render no chip). An `accountId` that no
 * longer resolves to a known account (removed) yields `Unknown account` for both.
 */
export function accountChipLabel(
  accountId: string | undefined,
  accounts: ClaudeAccount[]
): { short: string; tooltip: string } | null {
  if (!accountId) return null
  const acct = accounts.find((a) => a.id === accountId)
  if (!acct) return { short: 'Unknown account', tooltip: 'Unknown account' }
  const base = acct.label.split('@')[0]
  const short = base.length > 10 ? `${base.slice(0, 10)}…` : base
  const tooltip = acct.email ? `${acct.label} (${acct.email})` : acct.label
  return { short, tooltip }
}

/**
 * Display name for the SYSTEM (default `~/.claude`) account in pickers, settings, and the
 * usage popover: the user's custom label (settings.systemAccountLabel) wins, else the
 * detected login email, else the generic "System account". Keeps the system entry
 * distinguishable once managed accounts exist.
 */
export function systemAccountDisplay(label: string | undefined, email?: string | null): string {
  return (label ?? '').trim() || email || 'System account'
}

/**
 * Terminal node used to log a new managed account in: the session runs under the account's
 * CLAUDE_CONFIG_DIR (Task-3 env injection keyed off `data.accountId`), so `claude /login`
 * writes credentials + `.claude.json` into the account dir, where the main process captures
 * the email. A plain terminal (not an agent node) so no session-name tracking kicks in.
 *
 * In an SSH project, pass the project's `ssh` binding: the node then runs in REMOTE tmux (Task 12),
 * so `CLAUDE_CONFIG_DIR` resolves to the account dir ON THE HOST and `claude /login` writes the
 * remote `.claude.json` (the main process polls it over ssh). For a local account, omit `ssh`.
 */
export function createAccountLoginNode(
  accountId: string,
  index: number,
  center?: { x: number; y: number },
  ssh?: Project['ssh']
): CanvasNode {
  const node = createTerminalNode(index, undefined, center, undefined, ssh)
  node.data = {
    ...node.data,
    title: 'Claude login',
    accountId,
    initialCommand: 'claude /login'
  }
  return node
}

/**
 * True when node data is (or started as) an account-login terminal (`claude /login`).
 * `initialCommand` is one-shot and never persisted, so the factory title is the only durable
 * signature — serialized copies match on title alone. Used to DESTROY the login node together
 * with its removed account: left alive, a cold restart would respawn its `claude /login` under
 * the system env, where completing the OAuth overwrites the user's ~/.claude identity.
 */
export function isAccountLoginNode(data: { title?: string; initialCommand?: string }): boolean {
  return data.title === 'Claude login' || (data.initialCommand ?? '').startsWith('claude /login')
}

/**
 * Creates a code editor node for a file. When `sshFs` is true, `data.sshFs` is stamped so EditorNode
 * reads/writes over the project's remote fs (`sshFs`) and `filePath` is the remote path — mirroring
 * how `createTerminalNode` stamps `data.sshRemoteTmux`. The SSH-ness is passed EXPLICITLY by the
 * caller (only genuinely-remote, Explorer-opened files pass `true`); native-dialog-opened files
 * carry LOCAL paths and must stay local, so they omit it. (Self-detecting the active SSH project
 * here would wrongly stamp a dialog-opened local path and route its ⌘S write to the remote host.)
 */
export function createEditorNode(
  index: number,
  filePath: string,
  center?: { x: number; y: number },
  sshFs?: boolean
): CanvasNode {
  return {
    id: nextId('editor'),
    type: 'editor',
    position: placeAt(center, index, EDITOR_SIZE.width, EDITOR_SIZE.height),
    width: EDITOR_SIZE.width,
    height: EDITOR_SIZE.height,
    style: { width: EDITOR_SIZE.width, height: EDITOR_SIZE.height },
    data: {
      title: filePath.split('/').pop() || 'untitled',
      color: '#6ac4dc',
      group: null,
      filePath,
      ...(sshFs ? { sshFs: true } : {})
    }
  }
}

const VIDEO_EXTS = ['mp4', 'webm', 'mov', 'm4v', 'mkv', 'ogv', 'avi']

/** True when a path looks like a playable video file (by extension). */
export function isVideoFile(path: string): boolean {
  const ext = path.split('.').pop()?.toLowerCase() ?? ''
  return VIDEO_EXTS.includes(ext)
}

/** Creates a video player node for a local video file (streamed via nt-media://). */
export function createVideoNode(
  index: number,
  filePath: string,
  center?: { x: number; y: number }
): CanvasNode {
  return {
    id: nextId('video'),
    type: 'video',
    position: placeAt(center, index, VIDEO_SIZE.width, VIDEO_SIZE.height),
    width: VIDEO_SIZE.width,
    height: VIDEO_SIZE.height,
    style: { width: VIDEO_SIZE.width, height: VIDEO_SIZE.height },
    data: {
      title: filePath.split('/').pop() || 'video',
      color: '#bf5af2',
      group: null,
      filePath
    }
  }
}

/** Creates a web (webview) node showing a live URL or a local html file. */
export function createWebNode(
  index: number,
  src: { url?: string; filePath?: string },
  center?: { x: number; y: number }
): CanvasNode {
  const title = src.url
    ? src.url.replace(/^https?:\/\//, '').slice(0, 40)
    : src.filePath?.split('/').pop() || 'web'
  return {
    id: nextId('web'),
    type: 'web',
    position: placeAt(center, index, WEB_SIZE.width, WEB_SIZE.height),
    width: WEB_SIZE.width,
    height: WEB_SIZE.height,
    style: { width: WEB_SIZE.width, height: WEB_SIZE.height },
    data: {
      title,
      color: '#6ac4dc',
      group: null,
      ...(src.url ? { url: src.url } : {}),
      ...(src.filePath ? { filePath: src.filePath } : {})
    }
  }
}

/** Creates a navigable browser node (Electron <webview>) starting at `url` ('' = blank). */
export function createBrowserNode(
  index: number,
  url: string,
  center?: { x: number; y: number }
): CanvasNode {
  const title = url ? url.replace(/^https?:\/\//, '').slice(0, 40) : 'Browser'
  return {
    id: nextId('browser'),
    type: 'browser',
    position: placeAt(center, index, BROWSER_SIZE.width, BROWSER_SIZE.height),
    width: BROWSER_SIZE.width,
    height: BROWSER_SIZE.height,
    style: { width: BROWSER_SIZE.width, height: BROWSER_SIZE.height },
    data: {
      title,
      color: '#0a84ff',
      group: null,
      ...(url ? { url } : {})
    }
  }
}

/** Creates an SDK-driven chat node (Claude conversation without a terminal). */
export function createChatNode(
  index: number,
  cwd?: string,
  center?: { x: number; y: number },
  init?: { chatSessionId?: string; forkFrom?: string },
  accountId?: string
): CanvasNode {
  return {
    id: nextId('chat'),
    type: 'chat',
    position: placeAt(center, index, CHAT_SIZE.width, CHAT_SIZE.height),
    width: CHAT_SIZE.width,
    height: CHAT_SIZE.height,
    style: { width: CHAT_SIZE.width, height: CHAT_SIZE.height },
    data: {
      title: 'Chat',
      color: '#d97757', // clay, matches agent nodes
      group: null,
      // Chat nodes are always Claude — stamp the account when one was resolved/inherited.
      ...(accountId ? { accountId } : {}),
      ...(cwd ? { cwd } : {}),
      ...(init?.chatSessionId ? { chatSessionId: init.chatSessionId } : {}),
      ...(init?.forkFrom ? { forkFrom: init.forkFrom } : {})
    }
  }
}

/** Creates a diff editor node for a changed file (relative path + repo cwd). */
export function createDiffNode(
  index: number,
  cwd: string,
  relPath: string,
  staged: boolean,
  center?: { x: number; y: number },
  commitOid?: string
): CanvasNode {
  return {
    id: nextId('diff'),
    type: 'diff',
    position: placeAt(center, index, DIFF_SIZE.width, DIFF_SIZE.height),
    width: DIFF_SIZE.width,
    height: DIFF_SIZE.height,
    style: { width: DIFF_SIZE.width, height: DIFF_SIZE.height },
    data: {
      title: `${relPath.split('/').pop() || relPath} (${commitOid ? commitOid.slice(0, 7) : 'diff'})`,
      color: '#e0af68',
      group: null,
      cwd,
      filePath: relPath,
      diffStaged: staged,
      commitOid
    }
  }
}

/** Creates a new sticky note. */
export function createStickyNode(index: number, center?: { x: number; y: number }): CanvasNode {
  return {
    id: nextId('sticky'),
    type: 'sticky',
    position: placeAt(center, index, STICKY_SIZE.width, STICKY_SIZE.height),
    width: STICKY_SIZE.width,
    height: STICKY_SIZE.height,
    style: { width: STICKY_SIZE.width, height: STICKY_SIZE.height },
    data: {
      title: 'Note',
      color: '#ffd60a',
      group: null,
      text: ''
    }
  }
}

/** Creates a new dino (T-Rex Runner) game node, seeded with the project's record. */
export function createDinoNode(
  index: number,
  center?: { x: number; y: number },
  highScore = 0
): CanvasNode {
  return {
    id: nextId('dino'),
    type: 'dino',
    position: placeAt(center, index, DINO_SIZE.width, DINO_SIZE.height),
    width: DINO_SIZE.width,
    height: DINO_SIZE.height,
    style: { width: DINO_SIZE.width, height: DINO_SIZE.height },
    data: {
      title: 'Dino',
      color: '#a2a2a2',
      group: null,
      highScore
    }
  }
}

/** Creates a group frame node at a given position/size (children get parentId = its id). */
export function createGroupNode(
  position: { x: number; y: number },
  size: { width: number; height: number } = GROUP_SIZE,
  index = 0
): CanvasNode {
  return {
    id: nextId('group'),
    type: 'group',
    position,
    width: size.width,
    height: size.height,
    style: { width: size.width, height: size.height },
    data: {
      title: `Group ${index + 1}`,
      color: NODE_COLORS[index % NODE_COLORS.length],
      group: null
    }
  }
}

/** Creates a new project. When `ssh` is set, this is an SSH project (its terminals run remote). */
export function createProject(
  index: number,
  name?: string,
  cwd?: string,
  ssh?: Project['ssh']
): Project {
  return {
    id: nextId('project'),
    name: name ?? `Project ${index + 1}`,
    color: NODE_COLORS[index % NODE_COLORS.length],
    cwd,
    ...(ssh ? { ssh } : {}),
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: []
  }
}

const GROUP_PAD = 28
const GROUP_HEADER = 34

const nodeW = (n: CanvasNode) => n.measured?.width ?? (n.width as number) ?? 0
const nodeH = (n: CanvasNode) => n.measured?.height ?? (n.height as number) ?? 0

export type ArrangeLayout = 'grid' | 'row' | 'column'

/**
 * Repositions the given top-level ids into a non-overlapping layout starting at `origin`
 * (default: the bounding-box top-left of their current positions). 'row' packs left-to-right,
 * 'column' top-to-bottom, 'grid' wraps at `cols` (default ~square) with each row advancing by
 * its tallest member. Unknown ids and parented (grouped) nodes are skipped; returns the input
 * array unchanged when nothing resolves. Pure and deterministic.
 */
export function arrangeNodes(
  nodes: CanvasNode[],
  ids: string[],
  opts?: { layout?: ArrangeLayout; cols?: number; gap?: number; origin?: { x: number; y: number } }
): CanvasNode[] {
  const set = new Set(ids)
  const members = nodes.filter((nd) => set.has(nd.id) && !nd.parentId)
  if (members.length === 0) return nodes
  const layout = opts?.layout ?? 'grid'
  const gap = opts?.gap ?? 40
  const origin = opts?.origin ?? {
    x: Math.min(...members.map((m) => m.position.x)),
    y: Math.min(...members.map((m) => m.position.y))
  }
  const cols =
    layout === 'row' ? members.length : layout === 'column' ? 1 : Math.max(1, opts?.cols ?? Math.ceil(Math.sqrt(members.length)))

  const pos = new Map<string, { x: number; y: number }>()
  let x = origin.x
  let y = origin.y
  let rowH = 0
  members.forEach((m, i) => {
    if (i > 0 && i % cols === 0) {
      x = origin.x
      y += rowH + gap
      rowH = 0
    }
    pos.set(m.id, { x, y })
    x += nodeW(m) + gap
    rowH = Math.max(rowH, nodeH(m))
  })
  return nodes.map((nd) => (pos.has(nd.id) ? { ...nd, position: pos.get(nd.id)! } : nd))
}

export type AlignEdge = 'left' | 'right' | 'top' | 'bottom' | 'hcenter' | 'vcenter'

/**
 * Snaps the given top-level ids to a shared edge/center computed from their joint bounding box.
 * left/right/hcenter move x; top/bottom/vcenter move y. Unknown/parented ids are skipped;
 * returns the input array unchanged when nothing resolves. Pure.
 */
export function alignNodes(nodes: CanvasNode[], ids: string[], edge: AlignEdge): CanvasNode[] {
  const set = new Set(ids)
  const members = nodes.filter((nd) => set.has(nd.id) && !nd.parentId)
  if (members.length === 0) return nodes
  const minX = Math.min(...members.map((m) => m.position.x))
  const maxR = Math.max(...members.map((m) => m.position.x + nodeW(m)))
  const minY = Math.min(...members.map((m) => m.position.y))
  const maxB = Math.max(...members.map((m) => m.position.y + nodeH(m)))
  const cx = (minX + maxR) / 2
  const cy = (minY + maxB) / 2
  const move = (m: CanvasNode): { x: number; y: number } => {
    switch (edge) {
      case 'left':
        return { x: minX, y: m.position.y }
      case 'right':
        return { x: maxR - nodeW(m), y: m.position.y }
      case 'hcenter':
        return { x: cx - nodeW(m) / 2, y: m.position.y }
      case 'top':
        return { x: m.position.x, y: minY }
      case 'bottom':
        return { x: m.position.x, y: maxB - nodeH(m) }
      case 'vcenter':
        return { x: m.position.x, y: cy - nodeH(m) / 2 }
    }
  }
  const set2 = new Set(members.map((m) => m.id))
  return nodes.map((nd) => (set2.has(nd.id) ? { ...nd, position: move(nd) } : nd))
}

/**
 * Wraps the given top-level node ids in a new group frame: creates the group sized to
 * enclose them and reparents the children (positions become relative to the group).
 * Returns a new nodes array with the group placed first (React Flow needs parents first).
 */
export function groupSelectedNodes(
  nodes: CanvasNode[],
  ids: string[],
  groupIndex: number
): CanvasNode[] {
  const set = new Set(ids)
  const members = nodes.filter((n) => set.has(n.id) && !n.parentId && n.type !== 'group')
  if (members.length === 0) return nodes

  const minX = Math.min(...members.map((n) => n.position.x))
  const minY = Math.min(...members.map((n) => n.position.y))
  const maxX = Math.max(...members.map((n) => n.position.x + nodeW(n)))
  const maxY = Math.max(...members.map((n) => n.position.y + nodeH(n)))

  const gx = minX - GROUP_PAD
  const gy = minY - GROUP_PAD - GROUP_HEADER
  const group = createGroupNode(
    { x: gx, y: gy },
    { width: maxX - minX + GROUP_PAD * 2, height: maxY - minY + GROUP_PAD * 2 + GROUP_HEADER },
    groupIndex
  )

  const updated = nodes.map((n) =>
    set.has(n.id) && !n.parentId && n.type !== 'group'
      ? {
          ...n,
          parentId: group.id,
          extent: 'parent' as const,
          position: { x: n.position.x - gx, y: n.position.y - gy },
          selected: false
        }
      : n
  )
  return [group, ...updated]
}

/** Returns a copy of a node with a fresh id, offset position, and top-level placement. */
export function duplicateNode(node: CanvasNode, offset = 28): CanvasNode {
  const kind: NodeKind = node.type === 'sticky' ? 'sticky' : node.type === 'group' ? 'group' : 'terminal'
  const prefix = kind === 'terminal' ? 'term' : kind
  return {
    ...node,
    id: nextId(prefix),
    position: { x: node.position.x + offset, y: node.position.y + offset },
    selected: true,
    parentId: undefined,
    extent: undefined,
    data: { ...node.data, initialCommand: undefined }
  }
}

/** Removes a group frame and restores its children to absolute positions. */
export function ungroupNodes(nodes: CanvasNode[], groupId: string): CanvasNode[] {
  const group = nodes.find((n) => n.id === groupId)
  if (!group) return nodes
  return nodes
    .filter((n) => n.id !== groupId)
    .map((n) =>
      n.parentId === groupId
        ? {
            ...n,
            parentId: undefined,
            extent: undefined,
            position: { x: n.position.x + group.position.x, y: n.position.y + group.position.y }
          }
        : n
    )
}

/**
 * Moves a node into an existing group frame (`groupId` set) or out to the top level
 * (`groupId` null), keeping its on-canvas position fixed by converting between absolute and
 * group-relative coordinates (one level of nesting). Returns a new array with group nodes kept
 * before their children (React Flow requires parents first). No-op when the node is missing or
 * is itself a group, when it already has the requested parent, or when `groupId` is not a group.
 */
/** Group (parent) nodes must precede their children in the array (React Flow requirement). */
function groupsFirst(nodes: CanvasNode[]): CanvasNode[] {
  return [...nodes.filter((n) => n.type === 'group'), ...nodes.filter((n) => n.type !== 'group')]
}

/**
 * Returns `node` repositioned for a new parent (`targetParentId`, or null for top level),
 * keeping its on-canvas position fixed via absolute↔relative conversion (one level). Returns
 * the node unchanged if the target group is missing or not a group.
 */
function repositionForParent(
  node: CanvasNode,
  targetParentId: string | null,
  nodes: CanvasNode[]
): CanvasNode {
  const oldParent = node.parentId ? nodes.find((n) => n.id === node.parentId) : undefined
  const abs = {
    x: node.position.x + (oldParent?.position.x ?? 0),
    y: node.position.y + (oldParent?.position.y ?? 0)
  }
  if (targetParentId === null) {
    return { ...node, parentId: undefined, extent: undefined, position: abs }
  }
  const group = nodes.find((n) => n.id === targetParentId)
  if (!group || group.type !== 'group') return node
  return {
    ...node,
    parentId: group.id,
    extent: 'parent' as const,
    position: { x: abs.x - group.position.x, y: abs.y - group.position.y }
  }
}

export function reparentNode(
  nodes: CanvasNode[],
  nodeId: string,
  groupId: string | null
): CanvasNode[] {
  const node = nodes.find((n) => n.id === nodeId)
  if (!node || node.type === 'group') return nodes
  if ((node.parentId ?? null) === groupId) return nodes

  const updated = repositionForParent(node, groupId, nodes)
  if (updated === node) return nodes // target group missing / not a group
  return groupsFirst(nodes.map((n) => (n.id === nodeId ? updated : n)))
}

/**
 * Moves `draggedId` to sit immediately before `beforeId` in the array (sidebar order follows
 * array order). The dragged node also joins `beforeId`'s container (same reposition math) so a
 * drop both reorders within a group and can move across groups. No-op when either node is
 * missing, they are the same, or the dragged node is a group.
 */
export function reorderNodeBefore(
  nodes: CanvasNode[],
  draggedId: string,
  beforeId: string
): CanvasNode[] {
  if (draggedId === beforeId) return nodes
  const dragged = nodes.find((n) => n.id === draggedId)
  const before = nodes.find((n) => n.id === beforeId)
  if (!dragged || !before || dragged.type === 'group') return nodes

  const targetParent = before.parentId ?? null
  const moved =
    (dragged.parentId ?? null) === targetParent
      ? dragged
      : repositionForParent(dragged, targetParent, nodes)

  const without = nodes.filter((n) => n.id !== draggedId)
  const idx = without.findIndex((n) => n.id === beforeId)
  const result = [...without.slice(0, idx), moved, ...without.slice(idx)]
  return groupsFirst(result)
}

/** Converts persisted node states into live React Flow nodes (parents first). */
/**
 * Apply a single canvas mutation to a list of node states (renderer mirror of
 * `main/remote/canvas-sync`'s `applyMutation`, kept here to keep the renderer off the main-process
 * boundary). `upsert` replaces-or-appends by id; `remove` filters by id. Returns a NEW array
 * (the input is never mutated).
 */
export function applyCanvasMutation(
  states: CanvasNodeState[],
  m: CanvasMutation
): CanvasNodeState[] {
  if (m.op === 'remove') return states.filter((n) => n.id !== m.id)
  const idx = states.findIndex((n) => n.id === m.node.id)
  if (idx === -1) return [...states, m.node]
  const next = states.slice()
  next[idx] = m.node
  return next
}

export function nodeStatesToFlow(states: CanvasNodeState[]): CanvasNode[] {
  // React Flow requires a parent node to appear before its children in the array.
  const ordered = [...states].sort((a, b) => {
    if ((a.kind === 'group') === (b.kind === 'group')) return 0
    return a.kind === 'group' ? -1 : 1
  })
  return ordered.map((n) => {
    const collapsed = !!n.collapsed
    const height = collapsed ? COLLAPSED_HEIGHT : n.size.height
    // Legacy migration: nodes saved before `agentId` existed marked Claude via the 'claude'
    // tag. Backfill agentId so saved workspaces keep working.
    let agentId = n.agentId
    if (!agentId && Array.isArray(n.tags) && n.tags.includes('claude')) agentId = 'claude'
    return {
      id: n.id,
      // Default to 'terminal' for nodes saved before the kind field existed.
      type: n.kind ?? 'terminal',
      position: n.position,
      width: n.size.width,
      height,
      style: { width: n.size.width, height },
      ...(n.parentId ? { parentId: n.parentId, extent: 'parent' as const } : {}),
      data: {
        title: n.title,
        // Default true for older agent nodes saved before titleAuto existed, so they start
        // tracking the session name; non-agent nodes ignore it.
        titleAuto: n.titleAuto ?? true,
        color: n.color,
        group: n.group,
        tags: n.tags,
        collapsed,
        expandedHeight: n.size.height,
        shell: n.shell,
        cwd: n.cwd,
        text: n.text,
        filePath: n.filePath,
        url: n.url,
        diffStaged: n.diffStaged,
        commitOid: n.commitOid,
        highScore: n.highScore,
        agentId,
        accountId: n.accountId,
        ssh: n.ssh,
        sshRemoteTmux: n.sshRemoteTmux,
        sshFs: n.sshFs,
        worktree: n.worktree,
        chatSessionId: n.chatSessionId
      }
    }
  })
}

/** Serializes live React Flow nodes back into persisted node states. */
export function flowToNodeStates(nodes: CanvasNode[]): CanvasNodeState[] {
  const sizeFor = (kind: NodeKind) =>
    kind === 'sticky'
      ? STICKY_SIZE
      : kind === 'group'
        ? GROUP_SIZE
        : kind === 'editor'
          ? EDITOR_SIZE
          : kind === 'diff'
            ? DIFF_SIZE
            : kind === 'video'
              ? VIDEO_SIZE
              : kind === 'browser'
                ? BROWSER_SIZE
                : kind === 'web'
                  ? WEB_SIZE
                  : kind === 'dino'
                    ? DINO_SIZE
                    : kind === 'chat'
                      ? CHAT_SIZE
                      : TERMINAL_SIZE
  return nodes
    // Remote terminals are transient to a live relay connection — never persist them (their
    // connectionId is dead after a restart, and they'd otherwise reattach to a stray local tmux).
    .filter((n) => !n.data.remote)
    .map((n) => {
      const kind: NodeKind = (n.type as NodeKind) ?? 'terminal'
      const collapsed = !!n.data.collapsed
      return {
        id: n.id,
        kind,
        position: n.position,
        size: {
          width: n.measured?.width ?? n.width ?? sizeFor(kind).width,
          // While collapsed, persist the expanded height, not the shrunk one.
          height: collapsed
            ? n.data.expandedHeight ?? sizeFor(kind).height
            : n.measured?.height ?? n.height ?? sizeFor(kind).height
        },
        title: n.data.title,
        titleAuto: n.data.titleAuto,
        color: n.data.color,
        group: n.data.group,
        tags: n.data.tags,
        collapsed: n.data.collapsed,
        parentId: n.parentId,
        shell: n.data.shell,
        cwd: n.data.cwd,
        text: n.data.text,
        filePath: n.data.filePath,
        url: n.data.url,
        diffStaged: n.data.diffStaged,
        commitOid: n.data.commitOid,
        highScore: n.data.highScore,
        agentId: n.data.agentId,
        accountId: n.data.accountId,
        ssh: n.data.ssh,
        sshRemoteTmux: n.data.sshRemoteTmux,
        sshFs: n.data.sshFs,
        worktree: n.data.worktree,
        chatSessionId: n.data.chatSessionId
      }
    })
}
