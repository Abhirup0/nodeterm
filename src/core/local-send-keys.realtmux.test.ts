// SECURITY — the LOCAL delivery argv, run against a real tmux driving a real bash.
//
// This file proves what the ARGV does to TMUX, which is a different parser from the receiving
// app's and had a different hole: `send-keys -l` does not stop option parsing, so a payload
// beginning with `-` was consumed by tmux as FLAGS.
// Measured on tmux 3.4, every one of `-R  -K  -l  --  -H  -F  -N 3` exits 0 while typing nothing,
// so the delivery reported success — and then sent its Enter anyway, submitting whatever the human
// had already composed in that pane.
//
// `-R` is the worst of them and the reason the harm is not merely "the write was dropped": it
// RESETS THE PANE DISPLAY, so the composed line is wiped from the screen while readline still
// holds it. The human sees an empty prompt; the Enter that follows submits the line they can no
// longer see.
//
// The delivery no longer defends against that class — it cannot reach it. `sendText` hands the
// payload to `tmux load-buffer -` on STDIN, so the text is never an argument of anything and
// there is no option parser between it and the pane. The tests below run the same `-R` payload
// through the CURRENT delivery, and keep the pre-fix argv as a control so "structurally
// impossible" stays a measurement rather than a claim.
//
// A hand-rolled assertion on the argv array cannot see any of this: tmux's option parser is the
// only thing that knows which leading dashes it eats. So tmux is the judge, and a real bash pane
// is the witness for what the Enter did.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { localTmuxPasteArgs, localTmuxEnterArgs, pasteBufferName } from './tmux-naming'
import { makeTmuxTmpdir } from './tmux-test-socket'
import { sanitizePasteText } from './paste-injection'

/** A private socket, never `TMUX_SOCKET` — this must not touch a running nodeterm's tmux server. */
const SOCKET = `nt-sendkeys-test-${process.pid}`
const SESSION = 'nt-probe'

/**
 * The socket lives in the test's OWN temp dir, not `/tmp/tmux-<uid>/`.
 *
 * `kill-server` stops the server but does not unlink the socket file, so a per-pid socket name in
 * the shared dir leaves one stale entry behind per run, forever. Pointing `TMUX_TMPDIR` at `work`
 * makes `afterAll`'s `rm -rf` the one cleanup path for everything this file created.
 *
 * `makeTmuxTmpdir` picks the dir, because private is not the only constraint — the bound socket
 * path also has to fit `sun_path`, and under the macOS per-user temp root this file's own name
 * came to 106 of the 103 characters available. See `tmux-test-socket.ts`.
 */
function tmuxEnv(): NodeJS.ProcessEnv {
  return { ...process.env, TMUX_TMPDIR: work }
}

function findTmux(): string | null {
  for (const c of ['/usr/bin/tmux', '/usr/local/bin/tmux', '/opt/homebrew/bin/tmux', '/bin/tmux']) {
    if (fs.existsSync(c)) return c
  }
  return null
}

const TMUX = findTmux()
let work: string

/** `tmux <args>`, throwing on a non-zero exit exactly as `PtyManager`'s `runAsync` would. */
function tmux(args: string[], input?: string): string {
  return execFileSync(TMUX as string, args, { encoding: 'utf8', env: tmuxEnv(), input })
}

/** Type `body` into the probe pane the way the HARNESS does it — always safely quoted. */
function compose(body: string): void {
  tmux(['-L', SOCKET, 'send-keys', '-t', SESSION, '-l', '--', body])
}

/**
 * Wait for bash to have consumed everything sent so far.
 *
 * A sentinel, not a sleep: bash reads its input strictly in order, so once the sentinel's file
 * exists, every keystroke queued before it has already been acted on.
 */
function drain(tag: string): void {
  const sentinel = path.join(work, `sentinel-${tag}`)
  compose(`touch ${sentinel}`)
  tmux(['-L', SOCKET, 'send-keys', '-t', SESSION, 'Enter'])
  const deadline = Date.now() + 10_000
  while (!fs.existsSync(sentinel)) {
    if (Date.now() > deadline) throw new Error(`bash never reached the sentinel for ${tag}`)
    execFileSync('sleep', ['0.05'])
  }
}

function freshPane(): void {
  try {
    // Quiet: on the first run there is no server yet and tmux says so on stderr.
    execFileSync(TMUX as string, ['-L', SOCKET, 'kill-session', '-t', SESSION], {
      stdio: 'ignore',
      env: tmuxEnv()
    })
  } catch {
    // no session yet
  }
  tmux([
    '-L',
    SOCKET,
    'new-session',
    '-d',
    '-s',
    SESSION,
    '-x',
    '200',
    '-y',
    '40',
    '-e',
    'HISTFILE=/dev/null',
    '-c',
    work,
    'bash --norc --noprofile -i'
  ])
  // Ready = bash has painted SOMETHING (its prompt). Not a fixed string: `--norc` bash keeps its
  // own default PS1 whatever the environment says, and the prompt's text is not what this proves.
  const deadline = Date.now() + 10_000
  for (;;) {
    const pane = tmux(['-L', SOCKET, 'capture-pane', '-p', '-t', SESSION]).trim()
    if (pane.length > 0) return
    if (Date.now() > deadline) throw new Error('bash prompt never appeared')
    execFileSync('sleep', ['0.05'])
  }
}

beforeAll(() => {
  if (!TMUX) return
  work = makeTmuxTmpdir('nts-', SOCKET)
})

afterAll(() => {
  if (TMUX) {
    try {
      tmux(['-L', SOCKET, 'kill-server'])
    } catch {
      // already gone
    }
  }
  if (work) fs.rmSync(work, { recursive: true, force: true })
})

const suite = TMUX ? describe : describe.skip

suite('REAL tmux: a payload starting with `-` is text, never a flag', () => {
  it('a `-R` payload lands in the pane as characters instead of resetting it', () => {
    freshPane()
    const danger = path.join(work, 'danger')
    // The human has half-typed a command and has NOT pressed Enter yet.
    compose(`touch ${danger}`)
    // The agent's `write` verb arrives. `-R` is a real `send-keys` flag ("reset terminal state").
    // Through the current delivery it is buffer CONTENT, so tmux's option parser never sees it.
    tmux(
      localTmuxPasteArgs(SOCKET, SESSION, pasteBufferName(), true),
      sanitizePasteText('-R')
    )
    drain('minus-r')
    expect(
      fs.existsSync(danger),
      "the write typed NOTHING and its Enter submitted the human's composed line"
    ).toBe(false)
    // …and the payload really did arrive, appended to what was composed.
    expect(fs.existsSync(`${danger}-R`), 'the payload never reached the pane').toBe(true)
  })

  it('control: WITHOUT `--` tmux eats the payload as a flag, exits 0, and the Enter still fires', () => {
    // The mutation check, run rather than described — this is the shipped argv with `--` removed.
    // If this ever stops firing the composed line, the test above proves nothing.
    freshPane()
    const danger = path.join(work, 'danger-control')
    compose(`touch ${danger}`)
    const before = ['-L', SOCKET, 'send-keys', '-t', SESSION, '-l', '-R']
    // Exit 0: the caller (`sendText`) is told the text was delivered.
    expect(() => tmux(before)).not.toThrow()
    tmux(localTmuxEnterArgs(SOCKET, SESSION))
    drain('control')
    expect(fs.existsSync(danger), 'the pre-fix argv no longer submits the composed line').toBe(true)
    expect(fs.existsSync(`${danger}-R`)).toBe(false)
  })

  it('an ordinary payload still types and submits normally', () => {
    freshPane()
    const ok = path.join(work, 'framed')
    tmux(localTmuxPasteArgs(SOCKET, SESSION, pasteBufferName(), true), `touch ${ok}`)
    drain('framed')
    expect(fs.existsSync(ok)).toBe(true)
  })
})
