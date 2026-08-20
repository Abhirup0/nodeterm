import type { SessionSource } from '../session/session'

export type FileLinkDialect = 'posix' | 'windows'

export interface FileLinkDialectFacts {
  /** Which core owns the active tab's filesystem. */
  source: SessionSource
  /** True for the Server Edition's websocket-backed browser tab (currently source `local`). */
  browserRuntime: boolean
  /** The browser/window's OS. It is authoritative only for the local desktop core. */
  viewerWindows: boolean
  /** `process.platform` reported by the filesystem-owning core; null means it was not observed. */
  corePlatform: string | null
  /** An SSH project's fs API runs on its SSH host, whose supported dialect is POSIX. */
  sshProject: boolean
  /** A standalone ssh terminal has remote output but no remote filesystem API to verify links. */
  standaloneSsh: boolean
}

/**
 * Choose the dialect used by terminal output AND by the filesystem existence check behind it.
 *
 * A browser's OS is not evidence about a Server Edition or relay host. Guessing there makes a
 * Windows browser parse a Linux server's output as drive paths, and the inverse on a Windows host.
 * When the owning core could not report its platform, refuse file links until it can: an absent
 * link is recoverable; opening a same-looking path on the wrong machine is not.
 */
export function fileLinkDialect(facts: FileLinkDialectFacts): FileLinkDialect | null {
  if (facts.sshProject) return 'posix'
  if (facts.standaloneSsh) return null

  const platform =
    facts.corePlatform ??
    (facts.source === 'local' && !facts.browserRuntime
      ? facts.viewerWindows
        ? 'win32'
        : 'posix'
      : null)
  if (!platform) return null
  return platform === 'win32' ? 'windows' : 'posix'
}
