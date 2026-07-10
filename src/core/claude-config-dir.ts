// Resolve a managed Claude account's config dir under this app's persistent state root.
// The account LIST + login lifecycle live in main/claude-accounts.ts; this is just the
// impure path resolution (needs the platform seam for userDataDir) split out so core
// modules (chat-driver, pty-manager) can use it without importing electron.
import { platform } from './platform'
import { accountConfigDir } from './claude-accounts-core'

export function claudeConfigDirFor(accountId: string): string {
  return accountConfigDir(platform().userDataDir, accountId)
}
