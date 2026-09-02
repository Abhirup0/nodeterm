// TEST-ONLY — issue #629. The worker half of the tmux sandbox; see `tmux-sandbox.ts` for why.
//
// `globalSetup` runs in vitest's main process and the workers inherit its environment, so this file
// is usually re-stating what is already true. It exists because that inheritance is vitest's
// implementation detail, not its contract: a pool that snapshotted the environment before
// `globalSetup` ran would silently hand every worker the DEFAULT tmux directory — i.e. the
// machine's live `node-terminal` server — and nothing in a green suite would say so.
//
// It refuses rather than inventing a directory of its own. A per-worker fallback would be a sandbox
// nobody ever removes, and "the isolation is not wired" is exactly the thing that must be loud.
import fs from 'fs'
import { SANDBOX_ENV, enterSandbox } from '../../src/core/tmux-test-socket'

const sandbox = process.env[SANDBOX_ENV]
if (!sandbox || !fs.existsSync(sandbox)) {
  throw new Error(
    `tmux sandbox missing (${SANDBOX_ENV}=${sandbox ?? 'unset'}). vitest.config.ts must keep ` +
      'test/setup/tmux-sandbox.ts in `globalSetup` — without it a test naming `node-terminal` ' +
      "binds this machine's live nodeterm tmux server. See issue #629."
  )
}
enterSandbox(sandbox)
