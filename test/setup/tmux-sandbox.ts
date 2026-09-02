// TEST-ONLY — issue #629: the whole vitest run gets a private `TMUX_TMPDIR`, so no test can reach
// the tmux servers this machine is actually running nodeterm on.
//
// tmux resolves `-L <socket>` to `$TMUX_TMPDIR/tmux-<uid>/<socket>`, falling back to `/tmp` when
// the variable is unset. A test that names `node-terminal` or `nodeterm-rmt` therefore lands on the
// SHARED server carrying every live node on the machine — the developer's own canvas when the suite
// is run from inside a nodeterm terminal, which is how this repo is normally developed.
// `src/main/remote/host-destroy-tmux.test.ts` did exactly that by design (measured: it binds
// `node-terminal`, creates sessions on it and drives a real `PtyManager` against it), and
// `src/core/agents/pane-owner.test.ts` runs a real `tmux -L nodeterm-rmt` because the bytes it
// judges hardcode that name.
//
// Neither was proven to be the killer in #629 — the reporter's evidence points at the tmux server
// hitting a `fatal()` under the suite's process/fd burst, not at a `kill-server` from a test. But
// "the suite shares a server with the user's live sessions" is a hazard whatever kills it, and it
// is one this file removes by construction rather than by everybody remembering the rule.
//
// The sandbox is per RUN, not per file: `setup` creates it in the main process (so the workers
// inherit the variable), `teardown` kills whatever is still bound inside it and removes it. Suites
// that make their OWN private `TMUX_TMPDIR` are unaffected — this is the floor, not an override.
//
// WHAT IT DOES NOT DO: two suites naming the same socket inside the sandbox still share one tmux
// server, so a `kill-server` there is still a shared-server kill — it has just been moved somewhere
// harmless. Measured on CI the day this landed: the guard test's `kill-server` on `node-terminal`
// ended `host-destroy-tmux.test.ts`'s session mid-assertion. A suite kills its OWN sessions by
// exact target (`-t =<name>`), or it owns a socket name nothing else uses.
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import {
  SANDBOX_SOCKET_BUDGET,
  enterSandbox,
  makeTmuxTmpdir,
  tmuxSocketPath
} from '../../src/core/tmux-test-socket'

let dir: string | null = null

export async function setup(): Promise<void> {
  dir = makeTmuxTmpdir('ntvitest-', 'x'.repeat(SANDBOX_SOCKET_BUDGET))
  enterSandbox(dir)
}

export async function teardown(): Promise<void> {
  if (!dir) return
  killSandboxServers(dir)
  fs.rmSync(dir, { recursive: true, force: true })
  dir = null
}

/**
 * Kill every tmux server still bound inside the sandbox.
 *
 * `rm -rf` alone would unlink the socket and leave the server process running forever — which is
 * the shape of #629's leftovers (`nt-pr3-*` servers whose `afterAll` never ran, each still holding
 * its fake agents). Everything under this directory was started by this run, so there is nothing
 * else here to hit.
 */
function killSandboxServers(sandbox: string): void {
  const uid = process.getuid?.() ?? 0
  const socketDir = path.dirname(tmuxSocketPath(sandbox, uid, 'x'))
  let sockets: string[] = []
  try {
    sockets = fs.readdirSync(socketDir)
  } catch {
    return // nothing ever bound here
  }
  for (const socket of sockets) {
    try {
      execFileSync('tmux', ['-L', socket, 'kill-server'], {
        env: { ...process.env, TMUX_TMPDIR: sandbox },
        stdio: 'ignore'
      })
    } catch {
      /* no server on that socket, or no tmux at all — both fine */
    }
  }
}
