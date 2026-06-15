import type { Node } from '@xyflow/react'
import type { TerminalNodeState, Viewport, Workspace } from '@shared/types'

/** Preset color palette assigned to new terminals in order (for grouping/focus). */
export const NODE_COLORS = [
  '#7aa2f7', // blue
  '#9ece6a', // green
  '#e0af68', // yellow
  '#f7768e', // red
  '#bb9af7', // purple
  '#7dcfff', // cyan
  '#ff9e64' // orange
]

const DEFAULT_SIZE = { width: 440, height: 300 }

/** User data carried in the React Flow node's data field. */
export interface TermNodeData {
  title: string
  color: string
  group: string | null
  shell?: string
  cwd?: string
  [key: string]: unknown
}

export type TermNode = Node<TermNodeData, 'terminal'>

let idCounter = 0
function nextId(): string {
  return `term-${Date.now().toString(36)}-${++idCounter}`
}

/** Creates a new node for the toolbar's "New terminal" action. */
export function createTerminalNode(index: number): TermNode {
  return {
    id: nextId(),
    type: 'terminal',
    // Stagger placement so they don't overlap.
    position: { x: 80 + (index % 4) * 360, y: 80 + Math.floor(index / 4) * 320 },
    width: DEFAULT_SIZE.width,
    height: DEFAULT_SIZE.height,
    style: { width: DEFAULT_SIZE.width, height: DEFAULT_SIZE.height },
    data: {
      title: `Terminal ${index + 1}`,
      color: NODE_COLORS[index % NODE_COLORS.length],
      group: null
    }
  }
}

/** Converts a workspace read from disk into React Flow nodes. */
export function workspaceToNodes(ws: Workspace): TermNode[] {
  return ws.nodes.map((n) => ({
    id: n.id,
    type: 'terminal',
    position: n.position,
    width: n.size.width,
    height: n.size.height,
    style: { width: n.size.width, height: n.size.height },
    data: {
      title: n.title,
      color: n.color,
      group: n.group,
      shell: n.shell,
      cwd: n.cwd
    }
  }))
}

/** Converts live React Flow nodes into a workspace to write to disk. */
export function nodesToWorkspace(nodes: TermNode[], viewport: Viewport): Workspace {
  const serialized: TerminalNodeState[] = nodes.map((n) => ({
    id: n.id,
    position: n.position,
    size: {
      width: n.measured?.width ?? n.width ?? DEFAULT_SIZE.width,
      height: n.measured?.height ?? n.height ?? DEFAULT_SIZE.height
    },
    title: n.data.title,
    color: n.data.color,
    group: n.data.group,
    shell: n.data.shell,
    cwd: n.data.cwd
  }))
  return { version: 1, viewport, nodes: serialized }
}
