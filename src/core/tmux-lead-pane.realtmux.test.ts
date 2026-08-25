// LEAD-PANE WIDTH HOOKS (issue #119), PROVEN AGAINST A REAL TMUX.
//
// Unit tests pin what `tmuxConf`/`remoteTmuxConf` emit; whether tmux PARSES the hook lines and
// whether the guarded pair actually (a) restores a squeezed lead, (b) self-terminates, and
// (c) respects a manual width at/above the guard threshold is a property of tmux — so it is
// measured here, on this tmux, with the EXACT conf text `tmuxConf()` ships. This suite is what
// caught the string-compare trap: the issue reporter's original split hook used plain
// `#{<:pane_width,window_width}`, and on tmux 3.4 that is a STRING compare (#{<:59,200} = 0), so
// the hook silently never fired — the shipped conf uses the numeric `e|<` form instead.
//
// The Claude Code geometry being simulated is the one the reporter traced in the 2.1.227 binary:
// first teammate `split-window -h -l 70%`, later spawns `select-layout main-vertical` +
// `resize-pane -t <lead> -x 30%`.
//
// Each scenario runs on its OWN socket (`-f` is read only at server start, and a `new-session`
// racing a dying server's socket silently attaches WITHOUT the conf — measured: the hooks were
// absent and every assertion chased a phantom).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import path from 'path'
import { tmuxConf } from './pty-manager'
import { makeTmuxTmpdir } from './tmux-test-socket'

const SOCKET_OFF = `nt-lead0-${process.pid}`
const SOCKET_ON = `nt-lead1-${process.pid}`
// Window geometry the assertions are computed against (set via new-session -x/-y).
const W = 200

let tmp: string
let tmuxOk = false

function tmux(socket: string, args: string[]): string {
  return execFileSync('tmux', ['-L', socket, ...args], {
    env: { ...process.env, TMUX_TMPDIR: tmp },
    stdio: ['ignore', 'pipe', 'pipe']
  }).toString()
}

/** Start a fresh server from `conf` (a `-f` file is read once, at server start). */
function startServer(socket: string, conf: string, session: string): void {
  const file = path.join(tmp, `${session}.conf`)
  fs.writeFileSync(file, conf)
  tmux(socket, [
    '-f', file, 'new-session', '-d', '-x', String(W), '-y', '50', '-s', session, 'sleep 120'
  ])
}

function killServer(socket: string): void {
  try {
    tmux(socket, ['kill-server'])
  } catch {
    /* no server */
  }
}

function leadWidth(socket: string, session: string): number {
  return parseInt(
    tmux(socket, ['display-message', '-p', '-t', `${session}:0.0`, '#{pane_width}']),
    10
  )
}

/** Hooks run inside the server right after the triggering command; poll a beat for the settle. */
async function waitForWidth(
  socket: string,
  session: string,
  ok: (w: number) => boolean,
  ms = 3000
): Promise<number> {
  const t0 = Date.now()
  for (;;) {
    const w = leadWidth(socket, session)
    if (ok(w)) return w
    if (Date.now() - t0 > ms) return w
    await new Promise((r) => setTimeout(r, 50))
  }
}

beforeAll(() => {
  try {
    execFileSync('tmux', ['-V'], { stdio: 'ignore' })
    tmuxOk = true
  } catch {
    return // no tmux on this host — every test below self-skips
  }
  tmp = makeTmuxTmpdir('ntlead-', SOCKET_ON)
})

afterAll(() => {
  if (!tmuxOk) return
  killServer(SOCKET_OFF)
  killServer(SOCKET_ON)
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('setting OFF — the default conf really ships no hooks', () => {
  it('loads cleanly, configures zero hooks, and leaves the 70/30 squeeze alone (CC default behavior)', async () => {
    if (!tmuxOk) return
    startServer(SOCKET_OFF, tmuxConf(2000), 'off')
    // `show-hooks -g` prints every hook NAME even when unset — a configured entry is `name[0] …`.
    expect(tmux(SOCKET_OFF, ['show-hooks', '-g'])).not.toMatch(/\[\d+\]/)
    // CC's first-teammate split squeezes the lead to ~30% and NOTHING corrects it.
    tmux(SOCKET_OFF, ['split-window', '-h', '-l', '70%', '-t', 'off', 'sleep 120'])
    await new Promise((r) => setTimeout(r, 300))
    expect(leadWidth(SOCKET_OFF, 'off')).toBeLessThan(W / 2)
    killServer(SOCKET_OFF)
  })
})

describe('setting ON — the guarded hook pair, measured', () => {
  it('the generated conf parses and BOTH hooks are configured (new-session under -f)', () => {
    if (!tmuxOk) return
    startServer(SOCKET_ON, tmuxConf(2000, 72), 'on')
    const hooks = tmux(SOCKET_ON, ['show-hooks', '-g'])
    expect(hooks).toMatch(/after-resize-pane\[0\] if-shell/)
    expect(hooks).toMatch(/after-split-window\[0\] if-shell/)
  })

  it("CC's first teammate (split-window -h -l 70%) → the lead is nudged back to 72%", async () => {
    if (!tmuxOk) return
    tmux(SOCKET_ON, ['split-window', '-h', '-l', '70%', '-t', 'on', 'sleep 120'])
    // Without the hook the lead sits at ~59 of 200; the after-split-window hook restores 72%.
    const w = await waitForWidth(SOCKET_ON, 'on', (w) => w >= 0.7 * W)
    expect(w).toBeGreaterThanOrEqual(0.7 * W)
    expect(w).toBeLessThanOrEqual(0.74 * W)
  })

  it("CC's later rebalance (main-vertical + resize-pane -x 30%) → restored again; no resize loop", async () => {
    if (!tmuxOk) return
    tmux(SOCKET_ON, ['split-window', '-h', '-t', 'on', 'sleep 120']) // 3 panes: CC rebalances from here
    tmux(SOCKET_ON, ['select-layout', '-t', 'on', 'main-vertical'])
    tmux(SOCKET_ON, ['resize-pane', '-t', 'on:0.0', '-x', '30%']) // the clobber the issue is about
    const w = await waitForWidth(SOCKET_ON, 'on', (w) => w >= 0.7 * W)
    expect(w).toBeGreaterThanOrEqual(0.7 * W)
    // Self-termination: the hook's own resize fired the hook again and it no-opped (lead >= 60%).
    // A loop would keep the server busy re-resizing; a second stable read proves it settled.
    await new Promise((r) => setTimeout(r, 300))
    expect(leadWidth(SOCKET_ON, 'on')).toBe(w)
  })

  it('a manual width at/above the guard threshold is RESPECTED (the guard is a no-op, not a snap-back)', async () => {
    if (!tmuxOk) return
    // Guard for 72% is 60% (120 of 200). 130 >= 120, so the after-resize-pane hook must not touch it.
    tmux(SOCKET_ON, ['resize-pane', '-t', 'on:0.0', '-x', '130'])
    await new Promise((r) => setTimeout(r, 300))
    expect(leadWidth(SOCKET_ON, 'on')).toBe(130)
    killServer(SOCKET_ON)
  })
})
