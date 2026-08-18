import { promises as fs } from 'fs'
import { createHash } from 'node:crypto'
import path from 'path'
import type { ProjectTrustFamily } from '../shared/project-settings'
import type { SshConnection } from '../shared/ssh'
import { sshHostKey } from '../shared/ssh'
import { platform } from './platform'
import { writeAtomic } from './workspace-store'

export interface ProjectTrustRecord {
  contentHash: string
  approvedAt: string
}

/** Location identity, NEVER a project id (ids are attacker-controlled — hostile-project-json). */
export function localTrustKey(cwd: string): string {
  return `local\0${path.resolve(cwd)}`
}

export function sshTrustKey(ssh: { server: Pick<SshConnection, 'host' | 'user'>; remoteCwd: string }): string {
  return `ssh\0${sshHostKey(ssh.server)}\0${ssh.remoteCwd}`
}

export function hashTrustContent(content: string): string {
  return createHash('sha256').update(content, 'utf-8').digest('hex')
}

type TrustFileEntry = Partial<Record<ProjectTrustFamily, ProjectTrustRecord>>
type TrustFile = Record<string, TrustFileEntry>

/**
 * File: {userData}/project-trust.json. Lazy-loaded, cached; malformed file → empty store (fail
 * closed — an unreadable trust record must never be read back as "trusted").
 *
 * `record`/`revoke` serialize through an internal promise chain: both are read-modify-write over
 * the same in-memory + on-disk store, and two overlapping calls racing the read half would let the
 * later write silently clobber the earlier one's change.
 */
export class ProjectTrustStore {
  private cache: TrustFile | null = null
  private chain: Promise<unknown> = Promise.resolve()

  private get filePath(): string {
    return path.join(platform().userDataDir, 'project-trust.json')
  }

  private async load(): Promise<TrustFile> {
    if (this.cache) return this.cache
    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf-8')
    } catch {
      this.cache = {}
      return this.cache
    }
    try {
      const parsed: unknown = JSON.parse(raw)
      this.cache = parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as TrustFile) : {}
    } catch {
      this.cache = {}
    }
    return this.cache
  }

  async isTrusted(key: string, family: ProjectTrustFamily, contentHash: string): Promise<boolean> {
    const store = await this.load()
    return store[key]?.[family]?.contentHash === contentHash
  }

  async record(key: string, family: ProjectTrustFamily, contentHash: string, approvedAt: string): Promise<void> {
    return this.mutate((store) => {
      store[key] = { ...store[key], [family]: { contentHash, approvedAt } }
    })
  }

  async revoke(key: string, family?: ProjectTrustFamily): Promise<void> {
    return this.mutate((store) => {
      if (!store[key]) return
      if (!family) {
        delete store[key]
        return
      }
      const { [family]: _dropped, ...rest } = store[key]
      if (Object.keys(rest).length) store[key] = rest
      else delete store[key]
    })
  }

  private mutate(fn: (store: TrustFile) => void): Promise<void> {
    const run = this.chain.then(async () => {
      const store = await this.load()
      fn(store)
      this.cache = store
      await writeAtomic(this.filePath, JSON.stringify(store, null, 2))
    })
    this.chain = run.catch(() => {})
    return run
  }
}
