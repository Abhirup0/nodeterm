# Tester-Feedback Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the four grounded issues from the external tester report — mangled agent launch commands (P1), the feedback-less tmux install button (P2), weak canvas-control discovery (P3), and the empty-canvas/toolbar UX gaps (P4).

**Architecture:** P1 adds an echo-verified command-delivery state machine (pure renderer module) that `TerminalNode` uses for every one-shot launch command. P2 makes `PtyManager` re-probe tmux on demand and turns `TmuxBanner` into a `missing → installing → ready | failed` state machine that polls it. P3 broadens the canvas-control skill/instructions triggers and pushes a one-shot idle-gated discovery note per agent session. P4 is renderer-only polish (empty-canvas hint, SVG toolbar icons, Help→Documentation).

**Tech Stack:** TypeScript, React, zustand, vitest (node environment — pure-function tests only, no jsdom).

**Spec:** `docs/superpowers/specs/2026-07-15-tester-feedback-improvements-design.md`

## Global Constraints

- All code comments, UI strings, identifiers in **English** (CLAUDE.md convention).
- `src/core` must never import `electron` or `../main/*` (enforced by `src/core/no-electron.test.ts`).
- Renderer talks to main only via `window.nodeTerminal` / the injected `api` — never IPC directly.
- This repo is edited **concurrently by other sessions**: before each task, run `git pull --rebase 2>/dev/null || true` and re-check the target lines still match; verify any test failure against HEAD before assuming your change caused it.
- Fast correctness gate: `npm run typecheck`. Full suite: `npm test`.
- Known deviations from the spec's testing bullet (decided here): `ensureTmux` gets no unit test — importing `pty-manager` into vitest drags in the `node-pty` native module; it is covered by typecheck + the banner's poll path. The ghost hint gets no render test — it is a trivial conditional; the banner's poll verdict (`pollOutcome`) is unit-tested instead.
- Commit messages end with:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_019VnU4dDJZiCmAo7VCABceP`

---

### Task 1: Echo-verified command delivery (pure module + tests) — P1

**Files:**
- Create: `src/renderer/terminal/command-delivery.ts`
- Test: `src/renderer/terminal/command-delivery.test.ts`

**Interfaces:**
- Consumes: nothing (self-contained).
- Produces: `deliverCommand(io: DeliveryIo, cmd: string): () => void` (returns cancel), `interface DeliveryIo { write(data: string): void; onData(cb: (chunk: string) => void): () => void }`, plus exported constants `VERIFY_TIMEOUT_MS`, `DELIVERY_ATTEMPTS`, `ECHO_TAIL_CHARS` and helpers `cleanEcho(chunk: string): string`, `echoedIntact(cleanedSoFar: string, cmd: string): boolean`. Task 2 wires `deliverCommand` into `TerminalNode.tsx`.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/terminal/command-delivery.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DELIVERY_ATTEMPTS,
  VERIFY_TIMEOUT_MS,
  cleanEcho,
  deliverCommand,
  echoedIntact
} from './command-delivery'

const CMD = `claude --settings x 'implement the rerank feature for search results' --permission-mode auto`

function fakeIo() {
  const writes: string[] = []
  let cb: ((chunk: string) => void) | undefined
  return {
    writes,
    emit: (chunk: string) => cb?.(chunk),
    io: {
      write: (d: string) => writes.push(d),
      onData: (fn: (chunk: string) => void) => {
        cb = fn
        return () => {
          cb = undefined
        }
      }
    }
  }
}

describe('cleanEcho', () => {
  it('strips CSI, OSC and other escape sequences plus line breaks', () => {
    const noisy = '\x1b[1;32mprompt\x1b[0m \x1b]0;title\x07ec' + '\r\n' + 'ho text\x1b[K'
    expect(cleanEcho(noisy)).toBe('prompt echo text')
  })
})

describe('echoedIntact', () => {
  it('matches on the command tail, tolerating junk before it', () => {
    expect(echoedIntact(`% ${CMD}`, CMD)).toBe(true)
  })
  it('does not match a truncated echo (flush ate the tail)', () => {
    expect(echoedIntact(CMD.slice(0, -6), CMD)).toBe(false)
  })
})

describe('deliverCommand', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('writes the command without Enter, then submits once the echo confirms it', () => {
    const f = fakeIo()
    deliverCommand(f.io, CMD)
    expect(f.writes).toEqual([CMD])
    // Echo arrives in chunks, wrapped with \r\n and colored — still recognized.
    f.emit('\x1b[32m% \x1b[0m' + CMD.slice(0, 40) + '\r\n')
    f.emit(CMD.slice(40))
    expect(f.writes).toEqual([CMD, '\r'])
  })

  it('kills the line and rewrites when the echo never completes, then succeeds', () => {
    const f = fakeIo()
    deliverCommand(f.io, CMD)
    f.emit(CMD.slice(0, 30)) // the tty flush ate the rest
    vi.advanceTimersByTime(VERIFY_TIMEOUT_MS)
    expect(f.writes).toEqual([CMD, '\x15', CMD])
    f.emit(CMD) // clean echo on attempt 2
    expect(f.writes).toEqual([CMD, '\x15', CMD, '\r'])
  })

  it('fails open: after the last attempt times out it submits unverified', () => {
    const f = fakeIo()
    deliverCommand(f.io, CMD)
    for (let i = 0; i < DELIVERY_ATTEMPTS; i++) vi.advanceTimersByTime(VERIFY_TIMEOUT_MS)
    // attempt 1..N writes, N-1 kill-lines between them, final bare Enter.
    expect(f.writes.filter((w) => w === CMD)).toHaveLength(DELIVERY_ATTEMPTS)
    expect(f.writes.filter((w) => w === '\x15')).toHaveLength(DELIVERY_ATTEMPTS - 1)
    expect(f.writes[f.writes.length - 1]).toBe('\r')
  })

  it('cancel stops timers and listeners cold', () => {
    const f = fakeIo()
    const cancel = deliverCommand(f.io, CMD)
    cancel()
    vi.advanceTimersByTime(VERIFY_TIMEOUT_MS * DELIVERY_ATTEMPTS)
    f.emit(CMD)
    expect(f.writes).toEqual([CMD])
  })

  it('ignores echo arriving after submit (no double Enter)', () => {
    const f = fakeIo()
    deliverCommand(f.io, CMD)
    f.emit(CMD)
    f.emit(CMD)
    expect(f.writes).toEqual([CMD, '\r'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/terminal/command-delivery.test.ts`
Expected: FAIL — `Cannot find module './command-delivery'`.

- [ ] **Step 3: Write the implementation**

Create `src/renderer/terminal/command-delivery.ts`:

```ts
// Two-act delivery of a node's one-shot launch command (initialCommand / cold-restore
// resume) into a freshly spawned shell. Writing line+Enter blind races shell init: zsh's
// rc/ZLE setup resets the tty with a FLUSH that can eat part of the queued line, and a
// mangled line submitted anyway strands the shell at `quote>` (field report: 3 spawned
// team agents, none started, each needed a manual `'` + Enter). So: write WITHOUT Enter,
// wait until the shell has echoed the tail of the line back, THEN submit. A verify timeout
// kills the pending line (Ctrl-U) and rewrites; the LAST attempt submits unverified —
// fail-open, a terminal whose echo we can't recognize must never block the launch (that
// worst case is exactly the pre-fix behavior).

export const VERIFY_TIMEOUT_MS = 2000
export const DELIVERY_ATTEMPTS = 3
/** Long enough to be unambiguous in the echo stream, short enough that a ZLE wrap/redraw
 *  sequence interleaved mid-line rarely lands inside the matched window. */
export const ECHO_TAIL_CHARS = 24
const KILL_LINE = '\x15' // Ctrl-U — clear the pending input line before a rewrite

// CSI (\x1b[...X), OSC (\x1b]...BEL|ST) and single-char ESC sequences.
// eslint-disable-next-line no-control-regex
const ESC_SEQ = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g

/** Echo stream → comparable text: drop escape sequences and line breaks (ZLE re-wraps a
 *  long line with explicit \r\n at the terminal width). */
export function cleanEcho(chunk: string): string {
  // eslint-disable-next-line no-control-regex
  return chunk.replace(ESC_SEQ, '').replace(/[\r\n]/g, '')
}

/** Has the shell echoed the full line? Tail-match: the head is polluted by the prompt. */
export function echoedIntact(cleanedSoFar: string, cmd: string): boolean {
  return cleanedSoFar.includes(cmd.slice(-ECHO_TAIL_CHARS))
}

export interface DeliveryIo {
  write(data: string): void
  /** Subscribe to session output; returns unsubscribe. */
  onData(cb: (chunk: string) => void): () => void
}

/** Deliver `cmd` + Enter, echo-verified with bounded retries. Returns a cancel function
 *  (call on node teardown). */
export function deliverCommand(io: DeliveryIo, cmd: string): () => void {
  let done = false
  let attempt = 0
  let echoed = ''
  let timer: ReturnType<typeof setTimeout> | undefined
  let unsub: (() => void) | undefined

  const finish = (): void => {
    done = true
    if (timer) clearTimeout(timer)
    unsub?.()
  }
  const submit = (): void => {
    io.write('\r')
    finish()
  }
  const tryOnce = (): void => {
    if (done) return
    attempt += 1
    echoed = ''
    io.write(cmd)
    timer = setTimeout(() => {
      if (done) return
      if (attempt >= DELIVERY_ATTEMPTS) {
        submit() // fail-open: unverified submit beats a never-launched agent
        return
      }
      io.write(KILL_LINE)
      tryOnce()
    }, VERIFY_TIMEOUT_MS)
  }

  unsub = io.onData((chunk) => {
    if (done) return
    echoed += cleanEcho(chunk)
    if (echoedIntact(echoed, cmd)) {
      if (timer) clearTimeout(timer)
      submit()
    }
  })
  tryOnce()
  return finish
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/renderer/terminal/command-delivery.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck
git add src/renderer/terminal/command-delivery.ts src/renderer/terminal/command-delivery.test.ts
git commit -m "feat(terminal): echo-verified command delivery module

A launch command is now written without Enter, verified against the shell's
echo, and only then submitted; a verify timeout Ctrl-U's the line and retries
(3 attempts, final one fail-open). Groundwork for fixing spawned agent nodes
stranding at quote> when shell init's tty flush eats part of the line."
```

(Append the Global Constraints trailer lines to this and every commit message.)

---

### Task 2: Wire delivery into TerminalNode — P1

**Files:**
- Modify: `src/renderer/nodes/TerminalNode.tsx:1076-1102` (the `writeWhenShellReady` block)

**Interfaces:**
- Consumes: `deliverCommand(io, cmd)` from Task 1.
- Produces: nothing new — behavior change only. Both call sites of `writeWhenShellReady` (`data.initialCommand` at ~line 1106 and the cold-restore resume at ~line 1121) are covered automatically.

- [ ] **Step 1: Replace the blind write with verified delivery**

In `src/renderer/nodes/TerminalNode.tsx`, add the import near the other `./` / `../terminal/` imports:

```ts
import { deliverCommand } from '../terminal/command-delivery'
```

Then replace the comment block + function at lines 1076-1102 (currently ending the `fire` body with ``transport.write(sid, `${cmd}\n`)``) with:

```ts
        // Deliver a command only after the fresh shell settles, and never blind: zsh's init
        // (rc files / ZLE setup) resets the tty with a FLUSH that can eat part of a queued
        // line — a long agent launch line then sat at the prompt mangled (unbalanced quote →
        // `quote>` on Enter) instead of running. The settle wait below minimizes wasted
        // attempts; deliverCommand (echo-verify + retry, fail-open) guarantees a mangled
        // line is never submitted. See command-delivery.ts.
        const writeWhenShellReady = (cmd: string): void => {
          let done = false
          let timer: ReturnType<typeof setTimeout>
          const fire = (): void => {
            if (done) return
            done = true
            unsub()
            cleanups.push(
              deliverCommand(
                {
                  write: (d) => transport.write(sid, d),
                  onData: (cb) => transport.onData(sid, cb)
                },
                cmd
              )
            )
          }
          const unsub = transport.onData(sid, () => {
            if (done) return
            clearTimeout(timer)
            timer = setTimeout(fire, 200) // quiet for 200ms after output → prompt is up
          })
          timer = setTimeout(fire, 1500) // silence cap: no output at all → write anyway
          cleanups.push(() => {
            done = true
            clearTimeout(timer)
            unsub()
          })
        }
```

- [ ] **Step 2: Typecheck + full test suite**

Run: `npm run typecheck && npm test`
Expected: both pass (verify any failure against HEAD first — concurrent sessions).

- [ ] **Step 3: Manual verification (the field-report scenario)**

Run `npm run dev`, open a project, create a Claude agent node whose prompt contains single quotes (e.g. via pane menu → New Claude, or ask an existing Claude session to `spawn-team` with 3 roles). Expected: every spawned node's command line appears **complete** and runs without manual `'` + Enter. Also sanity-check a plain terminal with an `initialCommand` (e.g. the tmux banner's install button or `echo hi` via "Run in terminal" paths).

- [ ] **Step 4: Commit**

```bash
git add src/renderer/nodes/TerminalNode.tsx
git commit -m "fix(terminal): never submit a mangled launch command (quote> strand)

writeWhenShellReady now hands the line to deliverCommand: written without
Enter, matched against the shell's echo, submitted only when intact; timeout
kills the line and retries. Fixes spawned team agents needing a manual ' +
Enter when shell init's tty flush ate part of the launch line."
```

---

### Task 3: `ensureTmux()` — restart-free tmux pickup — P2 (core)

**Files:**
- Modify: `src/core/pty-manager.ts:534-559` (`init`) and `:628-643` (`tmuxStatus`)

**Interfaces:**
- Consumes: existing `findTmux()`, `tmuxConf()`, `TMUX_SOCKET`, `platform()` (all already imported in the file).
- Produces: `ensureTmux(): void` method on `PtyManager` — re-probes tmux when `this.tmuxPath` is null. `tmuxStatus()` calls it, so Task 4's polling banner gets restart-free pickup for free.

- [ ] **Step 1: Extract the tmux tail of `init()` into `ensureTmux()`**

Replace `init()` (lines 534-559) with:

```ts
  /** Must run after app is ready (needs userData path). */
  init(getSettings: () => Settings): void {
    this.getSettings = getSettings
    // Prewarm the login-shell PATH probe now so the first terminal spawn doesn't wait on it.
    void resolveShellPath()
    this.ensureTmux()
  }

  /** Probe tmux and write/push the generated config. Idempotent and safe to re-run: a later
   *  successful probe (e.g. right after the banner's install command finishes) brings tmux
   *  up for NEW sessions without an app restart — existing plain-shell sessions are left
   *  alone. No-op while tmux is already resolved or before init() provided settings. */
  ensureTmux(): void {
    if (this.tmuxPath || !this.getSettings) return
    const found = findTmux()
    if (!found) return
    this.confPath = path.join(platform().userDataDir, 'tmux.conf')
    try {
      fs.writeFileSync(this.confPath, tmuxConf(this.getSettings().tmuxScrollback))
    } catch {
      // If we can't write the config, stay on the plain-shell fallback.
      return
    }
    this.tmuxPath = found
    // The tmux server outlives the app, so it won't re-read `-f` on relaunch. Push the
    // (possibly updated) config into a running server now so new bindings apply immediately;
    // a no-op error when no server exists yet (the next session loads it fresh via `-f`).
    try {
      execFileSync(this.tmuxPath, ['-L', TMUX_SOCKET, 'source-file', this.confPath], {
        stdio: 'ignore'
      })
    } catch {
      // no server running yet — ignore
    }
  }
```

Note the deliberate reordering vs the old `init()`: `tmuxPath` is assigned **after** the conf write succeeds (the old code assigned then nulled on failure — same end state, but `ensureTmux` must stay re-runnable, so never leave a half-set path).

Check `this.getSettings` is declared as an optional/nullable field near the top of the class (it is — `init` used to be its only writer); if it is typed non-optional, make it `private getSettings?: () => Settings`.

- [ ] **Step 2: Re-probe from `tmuxStatus()`**

In `tmuxStatus()` (line 632), add the re-probe as the first line:

```ts
  tmuxStatus(): TmuxStatus {
    // Re-probe when unavailable: the banner polls this while its install command runs, and a
    // successful probe here is what makes new sessions tmux-backed without a restart.
    if (!this.tmuxPath) this.ensureTmux()
    const available = !!this.tmuxPath
    // ... rest unchanged
```

- [ ] **Step 3: Typecheck + suite**

Run: `npm run typecheck && npm test`
Expected: pass. (`src/core/no-electron.test.ts` guards the boundary — `ensureTmux` adds no new imports.)

- [ ] **Step 4: Commit**

```bash
git add src/core/pty-manager.ts
git commit -m "feat(pty): re-probe tmux on demand (ensureTmux) so an install lands without restart

init()'s tmux tail is extracted into idempotent ensureTmux(); tmuxStatus()
re-runs it while tmux is unresolved, so new sessions pick up a just-installed
tmux immediately. Existing plain-shell sessions are untouched."
```

---

### Task 4: TmuxBanner state machine (missing → installing → ready | failed) — P2 (renderer)

**Files:**
- Modify: `src/renderer/components/TmuxBanner.tsx` (full rework, 61 lines today)
- Test: `src/renderer/components/tmux-banner-phase.test.ts` (new — pure helper only; vitest runs in node env, no component render)

**Interfaces:**
- Consumes: `pty.tmuxStatus()` (unchanged wire shape `TmuxStatus`); Task 3's re-probe behind it.
- Produces: exported `type InstallPhase = 'missing' | 'installing' | 'ready' | 'failed'`, `pollOutcome(available: boolean, elapsedMs: number): InstallPhase`, constants `INSTALL_POLL_MS`, `INSTALL_CAP_MS`, `READY_HIDE_MS`. `Canvas.tsx:5396`'s `<TmuxBanner onInstall={runInTerminal} />` needs no change.

- [ ] **Step 1: Write the failing test**

Create `src/renderer/components/tmux-banner-phase.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { INSTALL_CAP_MS, pollOutcome } from './TmuxBanner'

describe('pollOutcome', () => {
  it('stays installing while unavailable and under the cap', () => {
    expect(pollOutcome(false, 0)).toBe('installing')
    expect(pollOutcome(false, INSTALL_CAP_MS - 1)).toBe('installing')
  })
  it('flips to ready the moment tmux is available — even past the cap', () => {
    expect(pollOutcome(true, 0)).toBe('ready')
    expect(pollOutcome(true, INSTALL_CAP_MS + 1)).toBe('ready')
  })
  it('fails once the cap elapses without tmux', () => {
    expect(pollOutcome(false, INSTALL_CAP_MS)).toBe('failed')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/renderer/components/tmux-banner-phase.test.ts`
Expected: FAIL — `pollOutcome` is not exported.

- [ ] **Step 3: Rework the component**

Replace the full contents of `src/renderer/components/TmuxBanner.tsx` with:

```tsx
import { useEffect, useRef, useState } from 'react'
import type { TmuxStatus } from '@shared/types'
import { localSession } from '../session/localSession'

// "tmux not found" strip: without tmux the app silently degrades to a plain shell — terminals
// don't survive restarts and the mobile companion can't attach — and nothing used to say so
// (one field report ran degraded for months without anyone noticing). Shown every launch until
// tmux is installed; the ✕ hides it for this session only. The install button runs the suggested
// package-manager command in a new terminal node (the gh-sign-in pattern) and — unlike the first
// version, which dismissed the banner optimistically and left the user guessing (second field
// report) — keeps the banner up as a status strip: installing → ready | failed. tmuxStatus()
// re-probes on every call (ensureTmux), so `available` flipping true is also what makes NEW
// terminals tmux-backed without a restart. Hidden on win32 and on any fetch error (fail-open).

export const INSTALL_POLL_MS = 3000
export const INSTALL_CAP_MS = 5 * 60_000
export const READY_HIDE_MS = 6000

export type InstallPhase = 'missing' | 'installing' | 'ready' | 'failed'

/** Poll verdict while installing: available wins outright; past the cap → failed. */
export function pollOutcome(available: boolean, elapsedMs: number): InstallPhase {
  if (available) return 'ready'
  return elapsedMs >= INSTALL_CAP_MS ? 'failed' : 'installing'
}

export function TmuxBanner({ onInstall }: { onInstall: (command: string) => void }): JSX.Element | null {
  const [status, setStatus] = useState<TmuxStatus | null>(null)
  const [dismissed, setDismissed] = useState(false)
  const [phase, setPhase] = useState<InstallPhase>('missing')
  const startedAtRef = useRef(0)

  useEffect(() => {
    let cancelled = false
    // Deliberately the LOCAL session, not useSession(): this banner is about THIS machine's tmux
    // (the host whose terminals lose continuity), never a relay tab's remote host.
    localSession.api.pty
      .tmuxStatus()
      .then((s) => {
        if (!cancelled) setStatus(s)
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  // While installing, poll tmuxStatus. The raw install output is visible in the spawned
  // terminal node either way — the banner only reports the outcome.
  useEffect(() => {
    if (phase !== 'installing') return
    const t = setInterval(() => {
      localSession.api.pty
        .tmuxStatus()
        .then((s) => {
          const next = pollOutcome(s.available, Date.now() - startedAtRef.current)
          if (next !== 'installing') setPhase(next)
        })
        .catch(() => {})
    }, INSTALL_POLL_MS)
    return () => clearInterval(t)
  }, [phase])

  // The success note has said what it needed to — take itself down.
  useEffect(() => {
    if (phase !== 'ready') return
    const t = setTimeout(() => setDismissed(true), READY_HIDE_MS)
    return () => clearTimeout(t)
  }, [phase])

  if (!status || dismissed || status.platform === 'win32') return null
  if (status.available && phase === 'missing') return null

  const title =
    phase === 'installing' ? 'Installing tmux' : phase === 'ready' ? 'tmux ready' : 'tmux not found'
  const body =
    phase === 'installing'
      ? 'Running the install in a terminal node — watch it for progress (it may ask for your password).'
      : phase === 'ready'
        ? 'New terminals will survive restarts from now on. Terminals opened before the install stay on the plain shell.'
        : phase === 'failed'
          ? 'The install hasn’t completed. Check the terminal node for errors, or install tmux with your package manager and restart nodeterm.'
          : status.installCommand
            ? 'Terminals won’t survive restarts and the mobile app can’t attach until tmux is installed.'
            : 'Terminals won’t survive restarts and the mobile app can’t attach. Install tmux with your package manager (e.g. brew install tmux), then restart nodeterm.'

  const showInstall = (phase === 'missing' || phase === 'failed') && !!status.installCommand
  return (
    <div className="announce-banner announce-banner--warning">
      <span className="announce-banner__dot" />
      <div className="announce-banner__content">
        <span className="announce-banner__title">{title}</span>
        <span className="announce-banner__body">{body}</span>
      </div>
      {showInstall && (
        <button
          className="announce-banner__btn"
          title={status.installCommand!}
          onClick={() => {
            onInstall(status.installCommand!)
            startedAtRef.current = Date.now()
            setPhase('installing')
          }}
        >
          {phase === 'failed' ? 'Retry' : (status.installLabel ?? 'Install tmux')}
        </button>
      )}
      <button className="announce-banner__close" title="Dismiss" onClick={() => setDismissed(true)}>
        ✕
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Run tests + typecheck**

Run: `npx vitest run src/renderer/components/tmux-banner-phase.test.ts && npm run typecheck`
Expected: PASS (3 tests) + clean typecheck.

- [ ] **Step 5: Manual verification**

On a machine (or container) without tmux: `npm run dev` → banner shows → click Install → banner flips to "Installing tmux" and stays; when the package manager finishes, within ~3 s it flips to "tmux ready"; a NEW terminal node then runs under tmux (check `tmux -L node-terminal ls` lists an `nt-…` session). If tmux is present, temporarily rename the binary to test.

- [ ] **Step 6: Commit**

```bash
git add src/renderer/components/TmuxBanner.tsx src/renderer/components/tmux-banner-phase.test.ts
git commit -m "feat(tmux-banner): installing/ready/failed states instead of optimistic dismiss

The install click keeps the banner as a status strip polling tmuxStatus()
(which now re-probes): success reports that new terminals are tmux-backed —
no restart — and a 5-minute cap surfaces failure with a Retry. Fixes the
field report of clicking Install and getting zero feedback."
```

---

### Task 5: Broaden canvas-control triggers (skill + instructions) — P3

**Files:**
- Modify: `src/main/canvas-control.ts:48` (skill `description`)
- Modify: `src/main/canvas-control-core.ts:112-116` (the intro paragraph inside `buildCanvasControlInstructions`)

**Interfaces:**
- Consumes/Produces: strings only; installers and merge logic untouched (`mergeCanvasControlBlock` idempotency tests in `canvas-control-core.test.ts` keep passing).

- [ ] **Step 1: Replace the skill description**

In `src/main/canvas-control.ts` line 48, replace the `description:` value with (one line, as today):

```
description: Create, organize and control nodes on the nodeterm canvas — open Claude Code / Codex / Gemini / terminal nodes, spawn a team of agents that divide up a task, create git worktrees as bound groups, wrap nodes in labeled groups, arrange/align/rename them, show an image/video/web page, write to or close a terminal. Use whenever the user says "Build with Nodeterm orchestration", asks to create or open nodes/sessions/terminals, split or parallelize work across subagents/agents/sessions/worktrees, delegate parts of a task to other agents, work on several things at once, build something using multiple Claude (or other agent) sessions, organize the canvas into groups by topic, or visualize code/output you produced. Only works inside a nodeterm Claude session.
```

(Diff vs today: "nodes/sessions" → "nodes/sessions/terminals"; adds "split or **parallelize** work across **subagents**/agents/sessions/worktrees", "**delegate** parts of a task to other agents", "work on several things at once".)

- [ ] **Step 2: Mirror the trigger sentence in the codex/gemini block**

In `src/main/canvas-control-core.ts`, inside `buildCanvasControlInstructions`, replace the intro lines

```
    'When you run inside a node on the nodeterm canvas, you can create and control other',
    'nodes (the CLI refuses outside a nodeterm session — do not retry there). Every node',
    'you open is connected to your node by an edge. Use this when the user asks you to open',
    'sessions/nodes, split work across agents, organize the canvas into groups, or show them',
    'an image/video/web page you produced.',
```

with

```
    'When you run inside a node on the nodeterm canvas, you can create and control other',
    'nodes (the CLI refuses outside a nodeterm session — do not retry there). Every node',
    'you open is connected to your node by an edge. Use this when the user asks you to open',
    'sessions/nodes/terminals, split or parallelize work across subagents/agents/worktrees,',
    'delegate parts of a task, organize the canvas into groups, or show them an',
    'image/video/web page you produced.',
```

- [ ] **Step 3: Suite + typecheck**

Run: `npm run typecheck && npx vitest run src/main/canvas-control-core.test.ts`
Expected: pass (the block-merge tests assert markers/idempotency, not the prose).

- [ ] **Step 4: Commit**

```bash
git add src/main/canvas-control.ts src/main/canvas-control-core.ts
git commit -m "feat(canvas-control): broaden skill/instruction triggers (parallelize, subagents, delegate)

A tester asking to 'split this task to subagents' is now squarely inside the
description's trigger phrasing for the skill and the codex/gemini blocks."
```

---

### Task 6: One-shot canvas-control discovery note — P3

**Files:**
- Modify: `src/renderer/lib/noteLink.ts` (add `buildCanvasControlNote`, `shouldPushControlNote`)
- Modify: `src/renderer/state/agentStatus.ts` (persisted `controlNoted` field + `setControlNoted` setter)
- Modify: `src/renderer/canvas/Canvas.tsx:4845-4850` (the `done` branch of the `onAgentStatus` listener)
- Test: `src/renderer/lib/noteLink.test.ts` (extend)

**Interfaces:**
- Consumes: `canControlCanvas(agentId)` from `@shared/agents/config` (already used at `Canvas.tsx:4028`); `api.pty.sendText` (appends Enter — this is why the push must be idle-gated); `AgentNodeStatus.sessionId`.
- Produces: `buildCanvasControlNote(agentId: string | undefined): string`; `shouldPushControlNote(s: { sessionId?: string; controlNoted?: string; canControl: boolean }): boolean`; store additions `AgentNodeStatus.controlNoted?: string` and `setControlNoted(id: string, sessionId: string): void`.

- [ ] **Step 1: Write the failing tests**

Append to `src/renderer/lib/noteLink.test.ts` (match the file's existing import/describe style):

```ts
describe('buildCanvasControlNote', () => {
  it('points claude at the skill and self-defuses', () => {
    const msg = buildCanvasControlNote('claude')
    expect(msg).toContain('manage-nodeterm-canvas')
    expect(msg).toContain('No action needed now')
    expect(msg).not.toContain('\n') // pty.sendText submits — a newline would split the prompt
  })
  it('points codex/gemini at their global instructions section', () => {
    const msg = buildCanvasControlNote('codex')
    expect(msg).toContain('manage-nodeterm-canvas')
    expect(msg).toContain('global agent instructions')
    expect(msg).not.toContain('\n')
  })
})

describe('shouldPushControlNote', () => {
  it('pushes once per session for a controllable agent', () => {
    expect(shouldPushControlNote({ sessionId: 's1', canControl: true })).toBe(true)
  })
  it('never re-pushes the same session', () => {
    expect(shouldPushControlNote({ sessionId: 's1', controlNoted: 's1', canControl: true })).toBe(false)
  })
  it('pushes again for a NEW session of the same node', () => {
    expect(shouldPushControlNote({ sessionId: 's2', controlNoted: 's1', canControl: true })).toBe(true)
  })
  it('skips non-controllable agents and unknown sessions', () => {
    expect(shouldPushControlNote({ sessionId: 's1', canControl: false })).toBe(false)
    expect(shouldPushControlNote({ canControl: true })).toBe(false)
  })
})
```

Add `buildCanvasControlNote, shouldPushControlNote` to the file's import list from `./noteLink`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/renderer/lib/noteLink.test.ts`
Expected: FAIL — missing exports.

- [ ] **Step 3: Implement the builders in `noteLink.ts`**

Append to `src/renderer/lib/noteLink.ts`:

```ts
/** One-shot discovery note: tells a canvas-controllable agent it can drive the canvas.
 *  Pushed on the session's FIRST completed turn (the node is idle then — pty.sendText
 *  appends Enter, so a mid-turn push would interrupt), once per sessionId. Model-agnostic
 *  on purpose: skill auto-triggering is Claude-Code behavior an alternative backend (GLM
 *  et al.) may never exercise, so the session is told directly. Same self-defusing tail
 *  as buildContextLinkNote — an agent that reads this as a task starts an unsolicited
 *  canvas reorganization. */
export function buildCanvasControlNote(agentId: string | undefined): string {
  if (!agentId || agentId === 'claude') {
    return `[nodeterm] This session can control the nodeterm canvas: open agent/terminal nodes, spawn a team that divides up a task, create worktree groups, organize nodes. Use the manage-nodeterm-canvas skill when asked to parallelize, delegate or organize work. No action needed now — just acknowledge briefly.`
  }
  return `[nodeterm] This session can control the nodeterm canvas: open agent/terminal nodes, spawn a team that divides up a task, group and arrange nodes. See the "Managing the nodeterm canvas (manage-nodeterm-canvas)" section of your global agent instructions for the CLI. No action needed now — acknowledge briefly.`
}

/** Gate for the discovery push: controllable agent, session known, not yet noted for THIS
 *  session (a resumed session keeps its id → no re-push; a fresh session gets one). */
export function shouldPushControlNote(s: {
  sessionId?: string
  controlNoted?: string
  canControl: boolean
}): boolean {
  return s.canControl && !!s.sessionId && s.controlNoted !== s.sessionId
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/renderer/lib/noteLink.test.ts`
Expected: PASS.

- [ ] **Step 5: Persist `controlNoted` in the agentStatus store**

In `src/renderer/state/agentStatus.ts`:

1. Add to `interface AgentNodeStatus` (after `sessionId`):

```ts
  /** SessionId the one-shot canvas-control discovery note was already pushed for. */
  controlNoted?: string
```

2. Add to `interface AgentStatusStore` (after `setSessionId`):

```ts
  /** Record that the canvas-control discovery note went out for this session. */
  setControlNoted(id: string, sessionId: string): void
```

3. In `save()` (line ~168), include the field — change the filter and the output object:

```ts
      for (const [id, v] of Object.entries(byId)) {
        if (v.unread || v.session || v.sessionId || v.loop || v.controlNoted) {
          out[id] = {
            unread: v.unread,
            session: v.session,
            sessionId: v.sessionId,
            loop: v.loop,
            controlNoted: v.controlNoted
          }
        }
      }
```

4. Add the setter next to `setSessionId` (same shape):

```ts
    setControlNoted: (id, sessionId) =>
      set((s) => {
        const prev = s.byId[id] ?? EMPTY
        if (prev.controlNoted === sessionId) return s
        const byId = { ...s.byId, [id]: { ...prev, controlNoted: sessionId } }
        save(byId)
        return { byId }
      }),
```

Check `src/renderer/state/agentStatus.persist.test.ts` — if it asserts the exact persisted shape, extend the expected objects with `controlNoted: undefined` or add a round-trip case for the new field.

- [ ] **Step 6: Wire the push into Canvas's done branch**

In `src/renderer/canvas/Canvas.tsx`, add to the imports from `../lib/noteLink` (already imported for `buildContextLinkNote`/`buildNotePushMessage`): `buildCanvasControlNote, shouldPushControlNote`. Confirm `canControlCanvas` is already imported from `@shared/agents/config` (used at line ~4028); add it if not.

Then in the `onAgentStatus` listener's `state` case (lines 4845-4850), extend the done branch:

```ts
          if (e.state === 'done' && !e.interrupted) {
            // Interrupted turns (Esc/Ctrl-C) alert nobody: the user did it themselves, and
            // the turn didn't complete, so it isn't a loop iteration either.
            cs.bumpLoop(e.nodeId, e.lastMessage) // count loop iterations + summary (no-op if not looping)
            alert('finished', `${agentLabel} finished its turn.`)
            // First completed turn of a controllable session → one-shot discovery note.
            // Idle now, so the sendText (which submits) can't interrupt a turn; keyed by
            // sessionId so a resume never repeats it. See buildCanvasControlNote.
            const st = cs.byId[e.nodeId]
            if (
              shouldPushControlNote({
                sessionId: st?.sessionId,
                controlNoted: st?.controlNoted,
                canControl: canControlCanvas(e.agentId)
              })
            ) {
              cs.setControlNoted(e.nodeId, st!.sessionId!)
              void api.pty.sendText(e.nodeId, buildCanvasControlNote(e.agentId))
            }
          }
```

Note: `api` must be in the effect's closure — the listener effect currently has `[]` deps and uses `api.onAgentStatus`, so `api` is already available; keep the dep array as-is (matching the file's existing convention for this effect).

- [ ] **Step 7: Full suite + typecheck + manual check**

Run: `npm run typecheck && npm test`
Expected: pass.
Manual: open a Claude node, give it a trivial prompt ("say hi"); when the turn finishes, the `[nodeterm] This session can control…` line is typed + submitted into the session exactly once; a second turn does not repeat it; an app restart + same session does not repeat it.

- [ ] **Step 8: Commit**

```bash
git add src/renderer/lib/noteLink.ts src/renderer/lib/noteLink.test.ts src/renderer/state/agentStatus.ts src/renderer/state/agentStatus.persist.test.ts src/renderer/canvas/Canvas.tsx
git commit -m "feat(canvas-control): one-shot idle-gated discovery note per agent session

On a controllable agent's first completed turn, push a single self-defusing
line telling it it can drive the canvas (skill pointer for claude, global
instructions pointer for codex/gemini). Keyed by sessionId in the persisted
agentStatus slice, so resumes and restarts never repeat it. Makes discovery
work for backends that ignore skill auto-triggering (GLM et al.)."
```

---

### Task 7: Empty-canvas ghost hint — P4

**Files:**
- Modify: `src/renderer/canvas/Canvas.tsx` (inside `.flow-wrap`, before `<SessionProvider>` at line ~5604)
- Modify: `src/renderer/styles.css` (new `.empty-canvas-hint` block, near the `.controls-cluster` styles ~line 1969)

**Interfaces:**
- Consumes: the live `nodes` array already in scope in Canvas's render.
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Add the hint markup**

In `Canvas.tsx`, immediately after `<div className="flow-wrap" ref={flowWrapRef}>`:

```tsx
        {/* First-contact guidance: an empty canvas used to be a black void (field report:
            "didn't know what to do first"). Pointer-events-none so it can never eat a
            right-click or box-select; keyed off the LIVE nodes array, so it reappears on
            any emptied project, not just first run (no persisted seen-flag — YAGNI). */}
        {nodes.length === 0 && (
          <div className="empty-canvas-hint" aria-hidden>
            <div>Right-click to add a terminal or agent</div>
            <div>
              <span className="kbd">⌘K</span> command palette · <span className="kbd">+</span> in the dock below
            </div>
          </div>
        )}
```

- [ ] **Step 2: Add the styles**

In `styles.css`, after the `.controls-cluster` block:

```css
/* Empty-canvas guidance — non-interactive, sits under every panel/dialog. */
.empty-canvas-hint {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  pointer-events: none;
  user-select: none;
  z-index: 1;
  color: rgba(255, 255, 255, 0.28);
  font-size: 14px;
  text-align: center;
}
.empty-canvas-hint .kbd {
  opacity: 0.7;
}
```

- [ ] **Step 3: Typecheck + manual check**

Run: `npm run typecheck`
Manual: new project → hint visible, right-click/box-select/pan all still work through it; add a node → hint gone; delete all nodes → hint back.

- [ ] **Step 4: Commit**

```bash
git add src/renderer/canvas/Canvas.tsx src/renderer/styles.css
git commit -m "feat(canvas): ghost hint on an empty canvas (right-click / ⌘K / dock)"
```

---

### Task 8: Toolbar SVG icons + Help → Documentation — P4

**Files:**
- Modify: `src/renderer/components/icons.tsx` (add `IconExplorer`, `IconGear`)
- Modify: `src/renderer/canvas/Canvas.tsx:5552-5601` (Explorer 🗂 → `<IconExplorer />`, ⚙ → `<IconGear />`, Help menu + Documentation item)
- Modify: `src/renderer/styles.css:2273-2290` (`.controls-cluster` icon sizing)

**Interfaces:**
- Consumes: the `S` svg-prop constant already in `icons.tsx`; `REPO_URL` from `../lib/bugReport` (already imported in Canvas for the Help menu).
- Produces: `IconExplorer`, `IconGear` components (stroke = currentColor, 16px viewBox pattern like `IconTerminal`).

- [ ] **Step 1: Add the icons**

In `src/renderer/components/icons.tsx`, following the `IconTerminal` pattern:

```tsx
export const IconExplorer = () => (
  <svg {...S}>
    {/* Folder — the Explorer drawer (file tree of the project cwd). */}
    <path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
  </svg>
)

export const IconGear = () => (
  <svg {...S}>
    <circle cx="12" cy="12" r="3" />
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1 1.55V21a2 2 0 1 1-4 0v-.09a1.7 1.7 0 0 0-1-1.55 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.55-1H3a2 2 0 1 1 0-4h.09a1.7 1.7 0 0 0 1.55-1 1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34h.09a1.7 1.7 0 0 0 1-1.55V3a2 2 0 1 1 4 0v.09a1.7 1.7 0 0 0 1 1.55 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87v.09a1.7 1.7 0 0 0 1.55 1H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.55 1z" />
  </svg>
)
```

- [ ] **Step 2: Use them in the toolbar + add the Documentation entry**

In `Canvas.tsx`:
- Add `IconExplorer, IconGear` to the existing import from `../components/icons`.
- Line 5552-5554: replace the `🗂` text child with `<IconExplorer />`.
- Line 5574: replace the `⚙` text child with `<IconGear />`.
- In the Help menu `items` (line 5584-5596), insert before the GitHub entry:

```ts
                {
                  label: 'Documentation',
                  onClick: () => window.nodeTerminal.shell.openExternal(`${REPO_URL}#readme`)
                },
```

(Target is the README per the spec — swap to a dedicated docs URL later, one line.)

- [ ] **Step 3: Size the icons up**

In `styles.css`, inside/after the `.controls-cluster > button` block (line ~2273):

```css
/* Icons read as 15px glyphs before — too small/ambiguous (field report). 18px for every
   SVG in the cluster (Explorer, Source Control, Phone, Gear) keeps the 34px buttons. */
.controls-cluster > button svg {
  width: 18px;
  height: 18px;
}
.sessions-icon-cluster > button svg {
  width: 18px;
  height: 18px;
}
```

- [ ] **Step 4: Typecheck + manual check**

Run: `npm run typecheck`
Manual: toolbar shows folder + gear SVGs at the larger size, aligned with Source Control/Phone; tooltips unchanged; Help menu shows Documentation → opens the repo README in the browser.

- [ ] **Step 5: Commit**

```bash
git add src/renderer/components/icons.tsx src/renderer/canvas/Canvas.tsx src/renderer/styles.css
git commit -m "feat(toolbar): SVG explorer/gear icons at 18px + Help → Documentation link"
```

---

## Final verification (after all tasks)

- [ ] `npm run typecheck && npm test` — green.
- [ ] Field-report replay: spawn-team with quoted prompts auto-starts all members (P1); tmux install click narrates its outcome (P2); a fresh agent session learns about canvas control after its first turn (P3); an empty canvas explains itself and the toolbar reads clearly (P4).
