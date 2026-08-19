// Resolve a managed Codex account's home under this app's persistent state root. The account LIST
// + login lifecycle live in a later PR's main/codex-accounts.ts; this is just the impure path
// resolution (it needs the platform seam for userDataDir) split out so core modules can use it
// without importing electron. Sibling of `claude-config-dir.ts`.
import { platform } from './platform'
import { codexHomeForAccount, codexSocketForAccount } from './codex-accounts-core'

/** The Codex home for an account id (or the system `~/.codex` when omitted), via the platform seam. */
export function codexHomeFor(accountId?: string): string {
  return codexHomeForAccount(platform().userDataDir, accountId)
}

/** The account's app-server control socket, via the platform seam. */
export function codexSocketFor(accountId?: string): string {
  return codexSocketForAccount(platform().userDataDir, accountId)
}
