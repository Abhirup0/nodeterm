// ISSUE #419, PROVEN AGAINST A REAL TMUX: the shared server must not leak one node's managed
// Claude/Codex account into another node's session.
//
// The mechanism under test: a tmux server inherits the process environment of whichever client
// STARTS it. An account node's client carries `CLAUDE_CONFIG_DIR=<account dir>` (pty-manager sets
// it in the spawn env), so a server started by that client holds the account dir in its GLOBAL
// env — and every later session created withOUT a `-e` override (system-account nodes, plain
// terminals, the missing-dir fallback) inherited it and silently ran as that account. That is the
// reporter's "the system account is somehow being entangled with the next account in the list",
// and "sometimes" because it depends on which node's client happened to start the server.
//
// The fix is the REMOVAL half of `update-environment`: the account-scope names are listed in the
// LOCAL conf (ACCOUNT_SCOPE_UPDATE_ENV), so tmux copies each one from the creating client's env —
// set for the node that owns it, STRIPPED from the session when the client lacks it. Whether tmux
// actually does that is a property of tmux, so it is measured here with the EXACT conf text
// `tmuxConf()` ships — same discipline as session-env.realtmux.test.ts, whose harness this copies
// (its server is seeded with the GATEWAY var; this one needs a server seeded with the ACCOUNT
// vars, which is why it runs its own private socket).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { tmuxConf } from './pty-manager'
import { makeTmuxTmpdir } from './tmux-test-socket'

const SOCKET = `nt-accttest-${process.pid}`

let tmp: string
let conf: string
let tmuxOk = false

function tmux(args: string[], env?: Record<string, string>): string {
  // TMUX_TMPDIR last: a caller's `env` chooses what the CLIENT carries, never which server it
  // reaches (see session-env.realtmux.test.ts).
  return execFileSync('tmux', ['-L', SOCKET, ...args], {
    env: { ...cleanEnv(), ...env, TMUX_TMPDIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString()
}

/** process.env minus the account-scope vars, so the HOST machine's own CLAUDE_CONFIG_DIR (this
 *  repo's dev boxes run nodeterm sessions themselves) can never seed or satisfy an assertion. */
function cleanEnv(): Record<string, string | undefined> {
  const e = { ...process.env }
  delete e.CLAUDE_CONFIG_DIR
  delete e.CODEX_HOME
  delete e.NODETERM_CODEX_ACCOUNT_ID
  return e
}

beforeAll(() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    tmuxOk = true
  } catch {
    return // no tmux on this host — every test below self-skips
  }
  tmp = makeTmuxTmpdir('ntacct-', SOCKET)
  conf = path.join(tmp, 'tmux.conf')
  fs.writeFileSync(conf, tmuxConf(2000))
})

afterAll(() => {
  if (!tmuxOk) return
  try {
    tmux(['kill-server'])
  } catch {
    /* already gone */
  }
  fs.rmSync(tmp, { recursive: true, force: true })
})

const waitFor = async (file: string, ms = 3000): Promise<string> => {
  const t0 = Date.now()
  for (;;) {
    if (fs.existsSync(file)) return fs.readFileSync(file, 'utf8')
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${file}`)
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('managed-account isolation on a shared tmux server (issue #419)', () => {
  it('an account node (client env + -e, the pty-manager shape) sees its own config dir', async () => {
    if (!tmuxOk) return
    const out = path.join(tmp, 'account-pane')
    // This FIRST create also starts the server, seeding its global env with the account dir —
    // the exact worst case the next test measures.
    tmux(
      [
        '-f', conf, 'new-session', '-d',
        '-e', 'CLAUDE_CONFIG_DIR=/ud/claude-accounts/a1',
        '-s', 'acct',
        `echo "DIR=[$CLAUDE_CONFIG_DIR] CX=[$CODEX_HOME]" > ${out}; sleep 5`
      ],
      {
        CLAUDE_CONFIG_DIR: '/ud/claude-accounts/a1',
        CODEX_HOME: '/ud/cx/a1',
        NODETERM_CODEX_ACCOUNT_ID: 'a1'
      }
    )
    expect(await waitFor(out)).toBe('DIR=[/ud/claude-accounts/a1] CX=[/ud/cx/a1]\n')
    // The seed is real: the server's global env now carries account a1.
    expect(tmux(['show-environment', '-g'])).toContain('CLAUDE_CONFIG_DIR=/ud/claude-accounts/a1')
  })

  it("a SYSTEM-account session on that seeded server does NOT inherit a1 — the #419 repro", async () => {
    if (!tmuxOk) return
    // A system node's client: no -e, no account vars in its env (pty-manager leaves them unset).
    // Pre-fix, this pane printed a1's dir — the session silently ran as the managed account.
    const out = path.join(tmp, 'system-pane')
    tmux(['new-session', '-d', '-s', 'system', `echo "DIR=[$CLAUDE_CONFIG_DIR] CX=[$CODEX_HOME]" > ${out}`])
    expect(await waitFor(out)).toBe('DIR=[] CX=[]\n')
  })

  it('a second account node on the seeded server still gets ITS dir, not the seed', async () => {
    if (!tmuxOk) return
    const out = path.join(tmp, 'account2-pane')
    tmux(
      [
        'new-session', '-d',
        '-e', 'CLAUDE_CONFIG_DIR=/ud/claude-accounts/b2',
        '-s', 'acct2',
        `echo "DIR=[$CLAUDE_CONFIG_DIR]" > ${out}`
      ],
      { CLAUDE_CONFIG_DIR: '/ud/claude-accounts/b2' }
    )
    expect(await waitFor(out)).toBe('DIR=[/ud/claude-accounts/b2]\n')
  })

  it('the codex SYSTEM overwrite now actually reaches a session on the shared server', async () => {
    if (!tmuxOk) return
    // pty-manager writes the system Codex scope EXPLICITLY into the client env ("so it overwrites
    // any managed scope a parent tmux server leaked in") — but a client's env only reaches the
    // session for names in update-environment, so before #419 that overwrite worked solely for
    // the client that started the server. Seeded server + explicit system client = system values.
    const out = path.join(tmp, 'codex-system-pane')
    tmux(
      ['new-session', '-d', '-s', 'cxsys', `echo "CX=[$CODEX_HOME] ID=[$NODETERM_CODEX_ACCOUNT_ID]" > ${out}`],
      { CODEX_HOME: '/home/u/.codex', NODETERM_CODEX_ACCOUNT_ID: '' }
    )
    expect(await waitFor(out)).toBe('CX=[/home/u/.codex] ID=[]\n')
  })
})
