import { promises as fs } from 'fs'
import path from 'path'
import { IPC } from '../shared/ipc'
import { platform } from './platform'
import {
  DEFAULT_PROJECT_ID, EMPTY_WORKSPACE,
  type Project, type Workspace, type WorkspaceV1
} from '../shared/types'
import {
  PROJECT_DIR, PROJECT_FILE, fileToProject, projectToFile, sameProjectContent,
  serializeProjectFile, splitWorkspace,
  type ProjectFileV1, type WorkspaceIndexV3
} from './workspace-files'

/** Remote file access for SSH projects (implemented in src/main over SshFs — src/core stays electron-free). */
export interface RemoteWorkspaceIO {
  read(projectId: string, ssh: NonNullable<Project['ssh']>): Promise<string | null>
  write(projectId: string, ssh: NonNullable<Project['ssh']>, content: string): Promise<boolean>
}

const projectFilePath = (cwd: string): string => path.join(cwd, PROJECT_DIR, PROJECT_FILE)

async function writeAtomic(filePath: string, content: string): Promise<void> {
  const tmp = `${filePath}.tmp`
  await fs.writeFile(tmp, content, 'utf-8')
  await fs.rename(tmp, filePath)
}

/**
 * v3 persistence: workspace.json is an index (refs + inline canvases); each local
 * project's data lives in <cwd>/.nodeterm/project.json (source of truth). The
 * renderer contract is unchanged: load() returns / save() takes an assembled
 * v2-shaped Workspace.
 */
export class WorkspaceStore {
  /** file path -> exact content we last wrote (skip-unchanged + watcher self-write suppression). */
  private lastWritten = new Map<string, string>()
  /** project id -> rev of the last written/loaded file. */
  private revs = new Map<string, number>()
  /** Raw v2 file content, kept until the first save backs it up (migration). */
  private pendingV2Backup: string | null = null
  /** ssh project ids whose last mirror write was dropped (connection down). Retried on every
   *  save/connect until a write confirms — guarantees the server file lands regardless of node
   *  type or creation timing. Runtime-only, never persisted. */
  private unmirrored = new Set<string>()
  /** Last index written/loaded — lets readLocalRef/refresh resolve entries without a full load. */
  private index: WorkspaceIndexV3 | null = null
  /** Optional hook fired after every load()/save() — the watcher re-syncs its watch set (Task 5). */
  onPersist?: () => void

  constructor(private remoteIO?: RemoteWorkspaceIO) {}

  private get indexPath(): string {
    return path.join(platform().userDataDir, 'workspace.json')
  }

  registerIpc(): void {
    platform().handle(IPC.workspaceLoad, () => this.load())
    platform().handle(IPC.workspaceSave, (workspace: Workspace) => this.save(workspace))
    platform().handle(IPC.workspaceProbeFolder, (folder: string) => this.probeFolder(folder))
  }

  /**
   * `sideline` (default true) forwards to readProjectFile: an unparsable/wrong-shape local
   * project.json is renamed to `.corrupt-<ts>` so a later save can't overwrite the only copy —
   * correct for boot/renderer loads. Read-only callers (e.g. the relay `projects.list` blob, which
   * a phone can trigger mid git-merge) pass false so a conflict-marked file is left hand-resolvable.
   */
  async load(opts?: { sideline?: boolean }): Promise<Workspace> {
    const result = await this.loadInner(opts?.sideline ?? true)
    this.onPersist?.()
    return result
  }

  private async loadInner(sideline: boolean): Promise<Workspace> {
    let raw: string
    try {
      raw = await fs.readFile(this.indexPath, 'utf-8')
    } catch {
      return EMPTY_WORKSPACE
    }
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return EMPTY_WORKSPACE
    }
    const anyParsed = parsed as { version?: number }
    if (anyParsed?.version === 3) return this.loadV3(parsed as WorkspaceIndexV3, sideline)
    // v1/v2: assemble in memory now; the first save() performs the actual migration.
    const legacy = migrateLegacy(parsed)
    if (legacy.projects.length) this.pendingV2Backup = raw
    return legacy
  }

  private async loadV3(index: WorkspaceIndexV3, sideline: boolean): Promise<Workspace> {
    this.index = index
    const projects: Project[] = []
    for (const e of index.entries) {
      if (e.project) {
        projects.push(e.project)
      } else if (e.cwd) {
        const p = await this.readProjectFile(e.cwd, sideline)
        if (p) {
          this.revs.set(p.id, p.rev)
          this.lastWritten.set(projectFilePath(e.cwd), serializeProjectFile(p))
          projects.push(fileToProject(p, { cwd: e.cwd, closed: e.closed }))
        } else {
          projects.push(unavailableProject(e))
        }
      } else if (e.ssh) {
        if (e.cache) {
          this.revs.set(e.id, e.cache.rev)
          projects.push(fileToProject(e.cache, { ssh: e.ssh, closed: e.closed }))
        } else {
          projects.push(unavailableProject(e))
        }
      }
    }
    const active = projects.some((p) => p.id === index.activeProjectId && !p.unavailable)
      ? index.activeProjectId
      : (projects.find((p) => !p.closed && !p.unavailable)?.id ?? '')
    return { version: 2, activeProjectId: active, projects }
  }

  /**
   * Reads + parses one project file. Only the authoritative loadV3 path passes `sideline: true`,
   * which renames an unparsable/wrong-shape file to `.corrupt-<ts>` so a later save can't overwrite
   * the only copy. Read-only callers (probeFolder — an RPC reachable with arbitrary paths on Server
   * Edition — and the watcher's readLocalRef*) pass false: a probe must never mutate the disk, and a
   * git-conflict-marked project.json mid-merge must be left in place so the user can hand-resolve it.
   */
  private async readProjectFile(cwd: string, sideline: boolean): Promise<ProjectFileV1 | null> {
    const file = projectFilePath(cwd)
    let raw: string
    try {
      raw = await fs.readFile(file, 'utf-8')
    } catch {
      return null
    }
    try {
      const parsed = JSON.parse(raw) as ProjectFileV1
      if (parsed?.version === 1 && typeof parsed.id === 'string' && Array.isArray(parsed.nodes)) return parsed
      // parses but isn't a ProjectFileV1 — sideline it too, so a later save can't overwrite the only copy.
    } catch { /* not JSON — sideline below */ }
    if (sideline) {
      try {
        await fs.rename(file, `${file}.corrupt-${Date.now()}`)
      } catch { /* best effort — never destroy data */ }
    }
    return null
  }

  async save(workspace: Workspace): Promise<void> {
    const savedAt = new Date().toISOString()
    const { index, files } = splitWorkspace(workspace, (id) => this.revs.get(id) ?? 0, savedAt)

    // An unavailable placeholder carries no real data. splitWorkspace already dropped its file
    // and cache; here we restore the machine-local payload (ssh offline cache) from the previous
    // index so the index rewrite doesn't drop a good cache we still can't reach.
    const unavailableIds = new Set(workspace.projects.filter((p) => p.unavailable).map((p) => p.id))
    if (unavailableIds.size) {
      for (const e of index.entries) {
        if (!unavailableIds.has(e.id)) continue
        const old = this.index?.entries.find((o) => o.id === e.id)
        if (old?.cache) e.cache = old.cache
      }
    }

    for (const [cwd, candidate] of files) {
      const file = projectFilePath(cwd)
      const prev = this.lastWritten.get(file)
      const prevParsed = prev ? (JSON.parse(prev) as ProjectFileV1) : null
      if (prevParsed && sameProjectContent(prevParsed, candidate)) continue
      const next: ProjectFileV1 = { ...candidate, rev: (this.revs.get(candidate.id) ?? 0) + 1 }
      const content = serializeProjectFile(next)
      try {
        await fs.mkdir(path.dirname(file), { recursive: true })
        await writeAtomic(file, content)
        this.lastWritten.set(file, content)
        this.revs.set(next.id, next.rev)
      } catch { /* folder gone (unmounted disk): the entry simply stays stale → unavailable next load */ }
    }

    // ssh caches: bump rev on change so a later remote write can win; mirror write in Task 8.
    for (const e of index.entries) {
      if (!e.ssh || !e.cache) continue
      const prevRev = this.revs.get(e.id) ?? 0
      const changedSinceLoad = !this.index?.entries.some(
        (old) => old.id === e.id && old.cache && sameProjectContent(old.cache, e.cache!)
      )
      e.cache.rev = changedSinceLoad ? prevRev + 1 : prevRev
      this.revs.set(e.id, e.cache.rev)
      // Mirror on change, and re-mirror while a previous write is still owed (the first save
      // often races the ControlMaster coming up — its write is dropped fail-open, and without
      // the retry nothing rewrites until the next real content change).
      if (this.remoteIO && (changedSinceLoad || this.unmirrored.has(e.id))) {
        const ok = await this.remoteIO.write(e.id, e.ssh, serializeProjectFile(e.cache))
        if (ok) this.unmirrored.delete(e.id)
        else this.unmirrored.add(e.id)
      }
    }

    // Back up the raw v2 file BEFORE the v3 index flip: a crash between the two must never leave a
    // migrated tree (project files already written above) without its pre-migration backup.
    const migrating = this.pendingV2Backup !== null
    if (migrating) {
      try {
        await writeAtomic(path.join(platform().userDataDir, 'workspace.v2.bak'), this.pendingV2Backup!)
      } catch { /* backup is best-effort */ }
      this.pendingV2Backup = null
    }

    // Compact index, atomic — same reasoning as the old single-file store.
    await writeAtomic(this.indexPath, JSON.stringify(index))
    this.index = index

    if (migrating) platform().broadcast(IPC.workspaceMigrated)

    this.onPersist?.()
  }

  async probeFolder(folder: string): Promise<Project | null> {
    const f = await this.readProjectFile(folder, false)
    return f ? fileToProject(f, { cwd: folder }) : null
  }

  localRefPaths(): string[] {
    return (this.index?.entries ?? []).filter((e) => e.cwd).map((e) => projectFilePath(e.cwd!))
  }

  isSelfWrite(filePath: string, content: string): boolean {
    return this.lastWritten.get(filePath) === content
  }

  async readLocalRef(projectId: string): Promise<Project | null> {
    const e = this.index?.entries.find((x) => x.id === projectId && x.cwd)
    if (!e?.cwd) return null
    const f = await this.readProjectFile(e.cwd, false)
    if (!f) return null
    this.revs.set(f.id, f.rev)
    this.lastWritten.set(projectFilePath(e.cwd), serializeProjectFile(f))
    return fileToProject(f, { cwd: e.cwd, closed: e.closed })
  }

  /** Maps a watched file path back to its project and re-reads it. */
  async readLocalRefByPath(filePath: string): Promise<Project | null> {
    const e = this.index?.entries.find((x) => x.cwd && projectFilePath(x.cwd) === filePath)
    return e ? this.readLocalRef(e.id) : null
  }

  /**
   * Called when an SSH project's connection comes up. Reconciles the server's
   * .nodeterm/project.json with our cached copy by rev: higher remote rev → adopt
   * remote (returned; caller broadcasts it); otherwise → push our cache up.
   */
  async refreshSshProject(projectId: string): Promise<Project | null> {
    const e = this.index?.entries.find((x) => x.id === projectId && x.ssh)
    if (!e?.ssh || !this.remoteIO) return null
    const raw = await this.remoteIO.read(projectId, e.ssh)
    let remote: ProjectFileV1 | null = null
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as ProjectFileV1
        if (parsed?.version === 1 && Array.isArray(parsed.nodes)) remote = parsed
      } catch { /* corrupt remote file → treat as absent, our cache pushes up */ }
    }
    const cacheRev = e.cache?.rev ?? 0
    if (remote && remote.rev > cacheRev) {
      e.cache = remote
      this.revs.set(projectId, remote.rev)
      this.unmirrored.delete(projectId) // the server copy IS the truth now — nothing owed
      await writeAtomic(this.indexPath, JSON.stringify(this.index))
      return fileToProject(remote, { ssh: e.ssh, closed: e.closed })
    }
    if (e.cache) {
      // Push-up runs with the master just up, but record the outcome anyway: a failed write
      // (connection flapped) stays owed so the next save retries it.
      const ok = await this.remoteIO.write(projectId, e.ssh, serializeProjectFile(e.cache))
      if (ok) this.unmirrored.delete(projectId)
      else this.unmirrored.add(projectId)
    }
    return null
  }
}

/** A labeled grey placeholder for a ref whose file can't be read right now. */
function unavailableProject(e: { id: string; name: string; color: string; closed?: boolean; cwd?: string; ssh?: Project['ssh'] }): Project {
  return {
    id: e.id, name: e.name, color: e.color,
    viewport: { x: 0, y: 0, zoom: 1 }, nodes: [],
    ...(e.cwd ? { cwd: e.cwd } : {}), ...(e.ssh ? { ssh: e.ssh } : {}),
    ...(e.closed ? { closed: true } : {}),
    unavailable: true
  }
}

/** Normalize legacy on-disk shapes (v1 single canvas, v2 projects) into a v2-shaped workspace. */
function migrateLegacy(parsed: unknown): Workspace {
  const ws = parsed as Partial<Workspace> & Partial<WorkspaceV1>
  if (ws?.version === 2 && Array.isArray(ws.projects)) {
    const active = ws.projects.some((p) => p.id === ws.activeProjectId)
      ? (ws.activeProjectId as string)
      : (ws.projects[0]?.id ?? '')
    return { version: 2, activeProjectId: active, projects: ws.projects }
  }
  if (ws?.version === 1 && Array.isArray(ws.nodes)) {
    return {
      version: 2,
      activeProjectId: DEFAULT_PROJECT_ID,
      projects: [{
        id: DEFAULT_PROJECT_ID, name: 'Project 1', color: '#7aa2f7',
        viewport: ws.viewport ?? { x: 0, y: 0, zoom: 1 }, nodes: ws.nodes
      }]
    }
  }
  return EMPTY_WORKSPACE
}
