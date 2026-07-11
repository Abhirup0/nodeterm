import path from 'path'
import type { BridgeLink, CanvasNodeState, Project, Viewport, Workspace } from '../shared/types'

export const PROJECT_DIR = '.nodeterm'
export const PROJECT_FILE = 'project.json'

/** On-disk shape of <cwd>/.nodeterm/project.json. No `cwd` field — the containing
 *  folder IS the cwd (that's what makes the folder relocatable). Node cwds inside
 *  the root are stored relative ("./sub"). Session/account state is included by
 *  design: the file is a single shared document (see the spec). */
export interface ProjectFileV1 {
  version: 1
  /** Monotonic save counter; picks a winner when an offline cache and the file diverge (SSH). */
  rev: number
  savedAt: string
  id: string
  name: string
  color: string
  viewport: Viewport
  nodes: CanvasNodeState[]
  bridges?: BridgeLink[]
  ropes?: BridgeLink[]
  defaultAccountId?: string
  dinoHighScore?: number
}

/** One workspace.json v3 entry. Exactly one of: `cwd` (local ref), `ssh` (remote ref),
 *  `project` (inline, cwd-less canvas). name/color are a cached header so an
 *  unavailable ref still renders a labeled grey tab. `cache` (ssh only) is the last
 *  ProjectFileV1 seen/written — used while the server is unreachable. */
export interface IndexEntryV3 {
  id: string
  name: string
  color: string
  closed?: boolean
  cwd?: string
  ssh?: Project['ssh']
  cache?: ProjectFileV1
  project?: Project
}

export interface WorkspaceIndexV3 {
  version: 3
  activeProjectId: string
  entries: IndexEntryV3[]
}

const isUnder = (p: string, root: string): boolean => {
  const rel = path.relative(root, p)
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}

/** Rewrites node cwds under `root` to portable "./…" form; other paths untouched. */
export function toPortableNodes(nodes: CanvasNodeState[], root: string): CanvasNodeState[] {
  return nodes.map((n) => {
    if (!n.cwd || !isUnder(n.cwd, root)) return n
    const rel = path.relative(root, n.cwd)
    return { ...n, cwd: rel === '' ? '.' : `./${rel.split(path.sep).join('/')}` }
  })
}

/** Resolves portable "./…" node cwds against `root`; absolute cwds pass through. */
export function resolveNodes(nodes: CanvasNodeState[], root: string): CanvasNodeState[] {
  return nodes.map((n) => {
    if (!n.cwd || !(n.cwd === '.' || n.cwd.startsWith('./'))) return n
    return { ...n, cwd: n.cwd === '.' ? root : path.join(root, n.cwd.slice(2)) }
  })
}

export function projectToFile(p: Project, rev: number, savedAt: string): ProjectFileV1 {
  return {
    version: 1,
    rev,
    savedAt,
    id: p.id,
    name: p.name,
    color: p.color,
    viewport: p.viewport,
    nodes: p.cwd ? toPortableNodes(p.nodes, p.cwd) : p.nodes,
    ...(p.bridges ? { bridges: p.bridges } : {}),
    ...(p.ropes ? { ropes: p.ropes } : {}),
    ...(p.defaultAccountId ? { defaultAccountId: p.defaultAccountId } : {}),
    ...(p.dinoHighScore ? { dinoHighScore: p.dinoHighScore } : {})
  }
}

export function fileToProject(
  f: ProjectFileV1,
  base: { cwd?: string; ssh?: Project['ssh']; closed?: boolean }
): Project {
  return {
    id: f.id,
    name: f.name,
    color: f.color,
    viewport: f.viewport,
    nodes: base.cwd ? resolveNodes(f.nodes, base.cwd) : f.nodes,
    ...(f.bridges ? { bridges: f.bridges } : {}),
    ...(f.ropes ? { ropes: f.ropes } : {}),
    ...(f.defaultAccountId ? { defaultAccountId: f.defaultAccountId } : {}),
    ...(f.dinoHighScore ? { dinoHighScore: f.dinoHighScore } : {}),
    ...(base.cwd ? { cwd: base.cwd } : {}),
    ...(base.ssh ? { ssh: base.ssh } : {}),
    ...(base.closed ? { closed: true } : {})
  }
}

/** Content equality ignoring the bookkeeping fields — decides whether a save must bump rev + rewrite. */
export function sameProjectContent(a: ProjectFileV1, b: ProjectFileV1): boolean {
  const strip = ({ rev: _r, savedAt: _s, ...rest }: ProjectFileV1) => rest
  return JSON.stringify(strip(a)) === JSON.stringify(strip(b))
}

/** Splits an in-memory workspace into the v3 index + the local project files to write. */
export function splitWorkspace(
  ws: Workspace,
  revOf: (projectId: string) => number,
  savedAt: string
): { index: WorkspaceIndexV3; files: Map<string, ProjectFileV1> } {
  const entries: IndexEntryV3[] = []
  const files = new Map<string, ProjectFileV1>()
  for (const p of ws.projects) {
    const header = { id: p.id, name: p.name, color: p.color, ...(p.closed ? { closed: true } : {}) }
    if (p.unavailable) {
      // Placeholder (folder missing / server unreachable at load): its nodes:[] is not real
      // data. Emit a header-only ref preserving the ref shape — NEVER a file and NEVER an ssh
      // cache built from the placeholder, so a later save can't clobber the on-disk source.
      if (p.ssh) entries.push({ ...header, ssh: p.ssh })
      else if (p.cwd) entries.push({ ...header, cwd: p.cwd })
      else {
        const { unavailable: _u, ...inline } = p
        entries.push({ ...header, project: inline })
      }
      continue
    }
    if (p.ssh) {
      entries.push({ ...header, ssh: p.ssh, cache: projectToFile(p, revOf(p.id), savedAt) })
    } else if (p.cwd && !files.has(p.cwd)) {
      files.set(p.cwd, projectToFile(p, revOf(p.id), savedAt))
      entries.push({ ...header, cwd: p.cwd })
    } else if (p.cwd) {
      // Another project already claimed this cwd (two tabs on one folder). Keying `files` by cwd
      // would collapse them last-wins, and reload would resurrect BOTH entries from the one file
      // (duplicate ids, first canvas lost). Emit this one INLINE instead — kept verbatim in the
      // index, no file write — so both canvases survive a save→load round trip.
      const { unavailable: _u, ...inline } = p
      entries.push({ ...header, project: inline })
    } else {
      const { unavailable: _u, ...inline } = p
      entries.push({ ...header, project: inline })
    }
  }
  return { index: { version: 3, activeProjectId: ws.activeProjectId, entries }, files }
}

/** Pretty, stable-order JSON for the project file (git-diffable; the index stays compact). */
export function serializeProjectFile(f: ProjectFileV1): string {
  return JSON.stringify(f, null, 2)
}
