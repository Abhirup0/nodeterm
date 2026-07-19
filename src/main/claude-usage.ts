// Electron shell for the usage service. Everything real — credential resolution, the OAuth
// fetch, the per-account cache, the RPC handlers — lives in src/core/usage/usage-service.ts so
// the Server Edition boots the same code. All that is left here is the one thing core cannot
// know: whether a desktop window is focused.
import type { BrowserWindow } from 'electron'
import { startUsageService, type UsageService } from '../core/usage/usage-service'

export { resolveClaudeAccessToken } from '../core/usage/usage-service'

/** Extra usage-service wiring the shell owns: the local managed accounts to poll for the mobile
 *  `usage` mirror block, and the mirror-flush callback fired on every cache update. */
export interface InitClaudeUsageOpts {
  localAccounts?: () => string[]
  onCacheUpdate?: () => void
}

/** Start the usage service on the focused-window poll gate and return it, so the caller can wire
 *  the agent-status mirror's `usage` provider off its `snapshot()`. */
export function initClaudeUsage(win: BrowserWindow, opts: InitClaudeUsageOpts = {}): UsageService {
  // Poll only while the window is focused, and re-check on focus — the usage endpoint has a
  // tight request budget and this data is informational, so an unattended app should not spend it.
  const service = startUsageService({
    shouldPoll: () => win.isFocused(),
    localAccounts: opts.localAccounts,
    onCacheUpdate: opts.onCacheUpdate
  })

  const onFocus = (): void => service.refreshIfStale()
  win.on('focus', onFocus)
  win.on('closed', () => {
    // Both matter: the timer keeps firing otherwise, and the listener kept a dead window
    // referenced (the pre-core version cleared the interval but never removed this handler).
    win.off('focus', onFocus)
    service.dispose()
  })
  return service
}
