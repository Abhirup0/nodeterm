import { create } from 'zustand'
import type { CanvasNodeState, Project, Viewport, Workspace } from '@shared/types'
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
  /** Writes the serialized canvas (nodes + viewport) back into a project. */
  commitCanvas(id: string, nodes: CanvasNodeState[], viewport: Viewport): void
  /** Removes a project; returns the id that should become active (never deletes the last one). */
  deleteProject(id: string): string

  toWorkspace(): Workspace
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

  commitCanvas(id, nodes, viewport) {
    set((s) => ({
      projects: s.projects.map((p) => (p.id === id ? { ...p, nodes, viewport } : p))
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
