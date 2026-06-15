import type { Node } from '@xyflow/react'
import type { CanvasNodeState, NodeKind, Project } from '@shared/types'

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

const TERMINAL_SIZE = { width: 440, height: 300 }
const STICKY_SIZE = { width: 240, height: 200 }
const GROUP_SIZE = { width: 520, height: 360 }

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
  shell?: string
  cwd?: string
  text?: string
  [key: string]: unknown
}

/** React Flow node type string mirrors the persisted NodeKind. */
export type CanvasNode = Node<NodeData, NodeKind>

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
  center?: { x: number; y: number }
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
      cwd
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
        text: n.text
      }
    }
  })
}

/** Serializes live React Flow nodes back into persisted node states. */
export function flowToNodeStates(nodes: CanvasNode[]): CanvasNodeState[] {
  const sizeFor = (kind: NodeKind) =>
    kind === 'sticky' ? STICKY_SIZE : kind === 'group' ? GROUP_SIZE : TERMINAL_SIZE
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
      text: n.data.text
    }
  })
}
