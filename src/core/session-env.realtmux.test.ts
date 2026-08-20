// ARGV-FREE CREDENTIAL DELIVERY, PROVEN AGAINST A REAL TMUX.
//
// The subject is the B3 fix of the dkattan-stack integration: gateway/custom env reaches an
// agent's tmux session through `update-environment` (values in the CLIENT's process env, names in
// the conf) — never through `-e KEY=VALUE` pairs parked on a long-lived client argv. Unit tests
// can only assert what the builders emit; whether tmux actually copies the values into the pane,
// and actually strips them for a client that lacks them, is a property of tmux — so it is
// measured here, on this tmux, with the EXACT conf text `tmuxConf()` ships.
//
// Also proven: the remote prologue (`remoteSessionEnvPrologue` via `remoteTmuxPtyArgs`) run
// through a real /bin/sh — the staged file is sourced into the tmux client's env, deleted, and
// its values land in the pane; a file that never appears costs 2s and nothing else.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { tmuxConf } from './pty-manager'
import { sessionEnvFileContent } from './remote-ssh/session-env'
import { makeTmuxTmpdir } from './tmux-test-socket'

/**
 * A private socket — never the live-session sockets, and never the SHARED `/tmp/tmux-<uid>/`
 * either. `kill-server` does not unlink the socket file, so a per-pid name in the shared dir left
 * one dead entry behind per run: 14 stale `nt-envtest-*` sockets had accumulated on one dev
 * machine. `TMUX_TMPDIR` points at this file's own temp dir, so `afterAll`'s `rm -rf` takes the
 * socket with it — the discipline the other two realtmux suites already had.
 */
const SOCKET = `nt-envtest-${process.pid}`

let tmp: string
let conf: string
let tmuxOk = false

function tmux(args: string[], env?: Record<string, string>): string {
  // TMUX_TMPDIR last: a caller's `env` chooses what the CLIENT carries, never which server it
  // reaches. Two sockets in one file would be two tmux servers and a test that proves nothing.
  return execFileSync('tmux', ['-L', SOCKET, ...args], {
    env: { ...process.env, ...env, TMUX_TMPDIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString()
}

beforeAll(() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    tmuxOk = true
  } catch {
    return // no tmux on this host — every test below self-skips
  }
  tmp = makeTmuxTmpdir('ntenv-', SOCKET)
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

describe('update-environment delivery (the argv-free gateway path)', () => {
  it('a client carrying the var in its process env hands it to the pane — argv stays clean', async () => {
    if (!tmuxOk) return
    const out = path.join(tmp, 'claude-pane')
    // The spawn args mirror the local branch: conf via -f, NO -e for the credential.
    tmux(
      ['-f', conf, 'new-session', '-d', '-s', 'agent', `echo "TOKEN=[$ANTHROPIC_AUTH_TOKEN]" > ${out}; sleep 5`],
      { ANTHROPIC_AUTH_TOKEN: 'vk-live-secret' }
    )
    expect(await waitFor(out)).toBe('TOKEN=[vk-live-secret]\n')
    // And the value is recorded in the SESSION env (tmux server memory), where later windows
    // read it — not on any argv.
    expect(tmux(['show-environment', '-t', 'agent'])).toContain(
      'ANTHROPIC_AUTH_TOKEN=vk-live-secret'
    )
  })

  it('a plain terminal (client withOUT the var) gets it STRIPPED, even on a seeded server', async () => {
    if (!tmuxOk) return
    // The server above was STARTED by a client whose env carried the token, i.e. the worst case:
    // server-global env is seeded with the secret. update-environment must still remove it for a
    // session created by a credential-less client — this is what keeps one node's gateway key out
    // of every plain terminal.
    const out = path.join(tmp, 'plain-pane')
    const env = { ...process.env }
    delete env.ANTHROPIC_AUTH_TOKEN
    execFileSync(
      'tmux',
      ['-L', SOCKET, 'new-session', '-d', '-s', 'plain', `echo "TOKEN=[$ANTHROPIC_AUTH_TOKEN]" > ${out}`],
      { env: { ...env, TMUX_TMPDIR: tmp }, stdio: ['ignore', 'pipe', 'pipe'] }
    )
    expect(await waitFor(out)).toBe('TOKEN=[]\n')
  })
})

describe('the remote prologue, run through a real /bin/sh', () => {
  it('sources the staged 0600 file into the tmux client env, deletes it, and the pane sees the value', async () => {
    if (!tmuxOk) return
    const envFile = path.join(tmp, 'nt-remote.env')
    fs.writeFileSync(envFile, sessionEnvFileContent({ ANTHROPIC_AUTH_TOKEN: "vk-remote'; echo pwned" }), {
      mode: 0o600
    })
    const out = path.join(tmp, 'remote-pane')
    // The exact prologue shape remoteSessionEnvPrologue emits (single quotes in the path are
    // impossible by construction; asserted against the builder in control-master tests). The
    // hostile value in the file proves sessionEnvFileContent's quoting: it must arrive as DATA.
    const prologue = `_nte=0; while [ ! -f '${envFile}' ] && [ "$_nte" -lt 40 ]; do sleep 0.05; _nte=$((_nte+1)); done; [ -f '${envFile}' ] && . '${envFile}' >/dev/null 2>&1; rm -f '${envFile}';`
    execFileSync(
      '/bin/sh',
      ['-c', `${prologue} tmux -L ${SOCKET} new-session -d -s remote 'echo "TOKEN=[$ANTHROPIC_AUTH_TOKEN]" > ${out}'`],
      // TMUX_TMPDIR has to reach the tmux INSIDE this shell too. Without it the prologue tests
      // start a second server for the same socket NAME on the shared dir, which afterAll's
      // kill-server (aimed at the private one) then leaves running with its socket on disk.
      { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, TMUX_TMPDIR: tmp } }
    )
    expect(await waitFor(out)).toBe("TOKEN=[vk-remote'; echo pwned]\n")
    // Sourced and GONE: nothing at rest on the host after the launch.
    expect(fs.existsSync(envFile)).toBe(false)
  })

  it('a file that never lands costs the bounded wait and nothing else (fail-open, env-less)', async () => {
    if (!tmuxOk) return
    const ghost = path.join(tmp, 'never-staged.env')
    const out = path.join(tmp, 'ghost-pane')
    const t0 = Date.now()
    const prologue = `_nte=0; while [ ! -f '${ghost}' ] && [ "$_nte" -lt 6 ]; do sleep 0.05; _nte=$((_nte+1)); done; [ -f '${ghost}' ] && . '${ghost}' >/dev/null 2>&1; rm -f '${ghost}';`
    execFileSync(
      '/bin/sh',
      ['-c', `${prologue} tmux -L ${SOCKET} new-session -d -s ghost 'echo "TOKEN=[$ANTHROPIC_AUTH_TOKEN]" > ${out}'`],
      { stdio: ['ignore', 'pipe', 'pipe'], env: (() => { const e: NodeJS.ProcessEnv = { ...process.env, TMUX_TMPDIR: tmp }; delete e.ANTHROPIC_AUTH_TOKEN; return e })() }
    )
    // 6 × 50ms wait budget, then the session still launched — without the env.
    expect(Date.now() - t0).toBeGreaterThanOrEqual(250)
    expect(await waitFor(out)).toBe('TOKEN=[]\n')
  })
})
