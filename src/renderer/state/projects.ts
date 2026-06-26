import { create } from 'zustand'
import type { BridgeLink, CanvasNodeState, Project, Viewport, Workspace } from '@shared/types'
import { createProject } from './workspace'

interface ProjectsState {
  projects: Project[]
  activeProjectId: string

  hydrate(ws: Workspace): void
  getProject(id: string): Project | undefined

  setActive(id: string): void
  /** Adds a new project and returns it (caller commits the current canvas first). */
  addProject(name?: string, cwd?: string): Project
  renameProject(id: string, name: string): void
  setProjectCwd(id: string, cwd: string): void
  /** Writes the serialized canvas (nodes + viewport + bridge links) back into a project. */
  commitCanvas(id: string, nodes: CanvasNodeState[], viewport: Viewport, bridges?: BridgeLink[]): void
  /** Renames a node within a project (source of truth for inactive projects). */
  renameNode(projectId: string, nodeId: string, title: string): void
  /** Recolors a node within a project. */
  recolorNode(projectId: string, nodeId: string, color: string): void
  /** Removes a node from a project. */
  removeNode(projectId: string, nodeId: string): void
  /** Duplicates a node within a project (fresh id, offset position). */
  duplicateNode(projectId: string, nodeId: string): void
  /** Moves a node into a group frame (groupId) or out to the top level (null), keeping its
   *  on-canvas position fixed by converting absolute/relative coordinates. */
  moveNodeToGroup(projectId: string, nodeId: string, groupId: string | null): void
  /** Reorders a node to sit immediately before another (sidebar order = array order),
   *  joining the target's container if they differ. */
  reorderNode(projectId: string, draggedId: string, beforeId: string): void
  /** Removes a project; returns the id that should become active (never deletes the last one). */
  deleteProject(id: string): string

  toWorkspace(): Workspace
}

/** Returns `node` repositioned for a new parent (groupId, or null for top level), keeping its
 *  on-canvas position fixed (one-level absolute↔relative). Unchanged if the target is not a
 *  group. `extent` is omitted — nodeStatesToFlow re-derives it from parentId on load. */
function repositionState(
  node: CanvasNodeState,
  groupId: string | null,
  nodes: CanvasNodeState[]
): CanvasNodeState {
  const oldParent = node.parentId ? nodes.find((n) => n.id === node.parentId) : undefined
  const abs = {
    x: node.position.x + (oldParent?.position.x ?? 0),
    y: node.position.y + (oldParent?.position.y ?? 0)
  }
  if (groupId === null) return { ...node, parentId: undefined, position: abs }
  const group = nodes.find((n) => n.id === groupId)
  if (!group || group.kind !== 'group') return node
  return {
    ...node,
    parentId: group.id,
    position: { x: abs.x - group.position.x, y: abs.y - group.position.y }
  }
}

/** Returns `projects` with one project's nodes transformed; other projects untouched. */
function mapProjectNodes(
  projects: Project[],
  projectId: string,
  fn: (nodes: CanvasNodeState[]) => CanvasNodeState[]
): Project[] {
  return projects.map((p) => (p.id === projectId ? { ...p, nodes: fn(p.nodes) } : p))
}

export const useProjects = create<ProjectsState>((set, get) => ({
  projects: [],
  activeProjectId: '',

  hydrate(ws) {
    set({ projects: ws.projects, activeProjectId: ws.activeProjectId })
  },

  getProject(id) {
    return get().projects.find((p) => p.id === id)
  },

  setActive(id) {
    set({ activeProjectId: id })
  },

  addProject(name, cwd) {
    const project = createProject(get().projects.length, name, cwd)
    set((s) => ({ projects: [...s.projects, project] }))
    return project
  },

  renameProject(id, name) {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, name } : p))
    }))
  },

  setProjectCwd(id, cwd) {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, cwd } : p))
    }))
  },

  commitCanvas(id, nodes, viewport, bridges) {
    set((s) => ({
      projects: s.projects.map((p) =>
        p.id === id ? { ...p, nodes, viewport, ...(bridges ? { bridges } : {}) } : p
      )
    }))
  },

  renameNode(projectId, nodeId, title) {
    set((s) => ({
      projects: mapProjectNodes(s.projects, projectId, (nodes) =>
        nodes.map((n) => (n.id === nodeId ? { ...n, title } : n))
      )
    }))
  },

  recolorNode(projectId, nodeId, color) {
    set((s) => ({
      projects: mapProjectNodes(s.projects, projectId, (nodes) =>
        nodes.map((n) => (n.id === nodeId ? { ...n, color } : n))
      )
    }))
  },

  removeNode(projectId, nodeId) {
    set((s) => ({
      projects: mapProjectNodes(s.projects, projectId, (nodes) =>
        nodes.filter((n) => n.id !== nodeId)
      )
    }))
  },

  duplicateNode(projectId, nodeId) {
    set((s) => ({
      projects: mapProjectNodes(s.projects, projectId, (nodes) => {
        const src = nodes.find((n) => n.id === nodeId)
        if (!src) return nodes
        const copy: CanvasNodeState = {
          ...src,
          id: `${src.kind}-${Math.random().toString(36).slice(2, 10)}`,
          title: `${src.title} copy`,
          position: { x: src.position.x + 24, y: src.position.y + 24 }
        }
        return [...nodes, copy]
      })
    }))
  },

  moveNodeToGroup(projectId, nodeId, groupId) {
    set((s) => ({
      projects: mapProjectNodes(s.projects, projectId, (nodes) => {
        const node = nodes.find((n) => n.id === nodeId)
        if (!node || node.kind === 'group') return nodes
        if ((node.parentId ?? null) === groupId) return nodes
        const next = repositionState(node, groupId, nodes)
        if (next === node) return nodes // target group missing / not a group
        return nodes.map((n) => (n.id === nodeId ? next : n))
      })
    }))
  },

  reorderNode(projectId, draggedId, beforeId) {
    set((s) => ({
      projects: mapProjectNodes(s.projects, projectId, (nodes) => {
        if (draggedId === beforeId) return nodes
        const dragged = nodes.find((n) => n.id === draggedId)
        const before = nodes.find((n) => n.id === beforeId)
        if (!dragged || !before || dragged.kind === 'group') return nodes
        const targetParent = before.parentId ?? null
        const moved =
          (dragged.parentId ?? null) === targetParent
            ? dragged
            : repositionState(dragged, targetParent, nodes)
        const without = nodes.filter((n) => n.id !== draggedId)
        const idx = without.findIndex((n) => n.id === beforeId)
        return [...without.slice(0, idx), moved, ...without.slice(idx)]
      })
    }))
  },

  deleteProject(id) {
    const { projects, activeProjectId } = get()
    const index = projects.findIndex((p) => p.id === id)
    const remaining = projects.filter((p) => p.id !== id)
    let nextActive = activeProjectId
    if (activeProjectId === id) {
      // pick the neighbor that takes this slot, or '' (welcome screen) when none remain
      nextActive = remaining.length ? remaining[Math.min(index, remaining.length - 1)].id : ''
    }
    set({ projects: remaining, activeProjectId: nextActive })
    return nextActive
  },

  toWorkspace() {
    const { projects, activeProjectId } = get()
    return { version: 2, activeProjectId, projects }
  }
}))
