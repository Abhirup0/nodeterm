import type { Node } from '@xyflow/react'
import type { CanvasNodeState, NodeKind, Project } from '@shared/types'
import type { AgentId } from '@shared/agents/config'
import { agentConfig } from '@shared/agents/config'
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

/** Height of a node when collapsed (header only). */
export const COLLAPSED_HEIGHT = 40

/** User data carried in the React Flow node's data field. */
export interface NodeData {
  title: string
  color: string
  group: string | null
  tags?: string[]
  collapsed?: boolean
  /** Expanded height to restore when un-collapsing (kept out of the persisted size). */
  expandedHeight?: number
  /** One-shot command run once when the terminal first opens (not persisted). */
  initialCommand?: string
  shell?: string
  cwd?: string
  text?: string
  filePath?: string
  diffStaged?: boolean
  commitOid?: string
  /** Which agent runs in this terminal node (claude/codex/gemini/custom). */
  agentId?: AgentId
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

/** Creates a new terminal node. `cwd` comes from the active project's default folder. */
export function createTerminalNode(
  index: number,
  cwd?: string,
  center?: { x: number; y: number },
  initialCommand?: string
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
      cwd,
      initialCommand
    }
  }
}

/**
 * Path to the bridge MCP config, fetched once from main at boot (see Canvas). When set, new
 * Claude nodes launch with `--mcp-config <path>` so the Session Bridge tools are available in
 * exactly the sessions nodeterm spawns — never the user's own `claude`.
 */
let bridgeConfigPath = ''
export function setBridgeConfigPath(p: string): void {
  bridgeConfigPath = p
}

/**
 * Command that launches Claude Code. Detection works via hooks installed globally in
 * ~/.claude/settings.json (gated by NODETERM_* env that the PTY manager sets), so a plain
 * `claude` is enough. We add `--mcp-config` to attach the Session Bridge MCP server. Append
 * `-r <id>` to resume a specific session (used by Branch).
 */
export function claudeLaunchCommand(): string {
  return bridgeConfigPath ? `claude --mcp-config "${bridgeConfigPath}"` : 'claude'
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
 * Creates a terminal node that launches the given agent on open. Title, color, and the
 * launch command come from the resolved agent config (builtin or custom); the node carries
 * `agentId` so the rest of the app (hooks, capabilities, UI) can branch on it. For `claude`
 * we use `claudeLaunchCommand()` which appends the Session Bridge `--mcp-config` (Claude-only).
 */
export function createAgentNode(
  agentId: AgentId,
  index: number,
  cwd?: string,
  center?: { x: number; y: number },
  initialPrompt?: string
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
      color,
      group: null,
      tags: [],
      agentId,
      cwd,
      initialCommand
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

/** Creates a code editor node for a file. */
export function createEditorNode(
  index: number,
  filePath: string,
  center?: { x: number; y: number }
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
      filePath
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

/** Creates a new project. */
export function createProject(index: number, name?: string, cwd?: string): Project {
  return {
    id: nextId('project'),
    name: name ?? `Project ${index + 1}`,
    color: NODE_COLORS[index % NODE_COLORS.length],
    cwd,
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: []
  }
}

const GROUP_PAD = 28
const GROUP_HEADER = 34

const nodeW = (n: CanvasNode) => n.measured?.width ?? (n.width as number) ?? 0
const nodeH = (n: CanvasNode) => n.measured?.height ?? (n.height as number) ?? 0

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

/** Converts persisted node states into live React Flow nodes (parents first). */
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
        color: n.color,
        group: n.group,
        tags: n.tags,
        collapsed,
        expandedHeight: n.size.height,
        shell: n.shell,
        cwd: n.cwd,
        text: n.text,
        filePath: n.filePath,
        diffStaged: n.diffStaged,
        commitOid: n.commitOid,
        agentId
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
            : TERMINAL_SIZE
  return nodes.map((n) => {
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
      color: n.data.color,
      group: n.data.group,
      tags: n.data.tags,
      collapsed: n.data.collapsed,
      parentId: n.parentId,
      shell: n.data.shell,
      cwd: n.data.cwd,
      text: n.data.text,
      filePath: n.data.filePath,
      diffStaged: n.data.diffStaged,
      commitOid: n.data.commitOid,
      agentId: n.data.agentId
    }
  })
}
