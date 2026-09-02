// TEST-ONLY: choosing a private `TMUX_TMPDIR` for the `*.realtmux.test.ts` suites.
//
// Two things a real-tmux test has to get right about its socket, and each has bitten this repo:
//
// 1. **It must be private**, so `afterAll`'s `rm -rf` is the one cleanup path. `kill-server` stops
//    the server but never unlinks the socket file, so a per-pid name in the SHARED `/tmp/tmux-<uid>/`
//    leaves one dead entry behind per run, forever — measured at 14 stale `nt-envtest-*` sockets on
//    one dev machine before this module existed.
// 2. **It must be SHORT.** A unix socket path is bound into a fixed `sockaddr_un.sun_path`, and the
//    macOS per-user temp root is already 56 characters before anything is added to it. This is not
//    theoretical: `local-send-keys.realtmux.test.ts` came to 106 and every test in it failed with
//    `error connecting to …: File name too long`, which reads like a broken test rather than a
//    path-length limit. Its sibling passed at 97 — six characters from the same failure.
//
// Production is not exposed to (2): `PtyManager` binds `-L node-terminal` under the default
// `/tmp/tmux-<uid>/`, which is short on every platform we ship to.
import fs from 'fs'
import os from 'os'
import path from 'path'

/**
 * The longest socket path that can be bound.
 *
 * macOS `sys/un.h` declares `sun_path[104]` — 103 characters plus the NUL. Linux allows 107. The
 * smaller number is the one to hold everywhere: a limit that only bites on a contributor's Mac is
 * worse than one that bites in CI, because it looks like the test is broken.
 */
export const SUN_PATH_MAX = 103

/** `mkdtemp` replaces a trailing `XXXXXX`, so the directory is always six characters longer. */
export const MKDTEMP_SUFFIX_LEN = 6

/** Where tmux binds for `-L <socket>` under `TMUX_TMPDIR=<dir>`. */
export function tmuxSocketPath(dir: string, uid: number, socket: string): string {
  return path.join(dir, `tmux-${uid}`, socket)
}

/**
 * The first base directory under which `mkdtemp(<base>/<prefix>XXXXXX)` still leaves room for the
 * socket, or `null` when none does. Bases are tried in the order given, so the caller states its
 * preference; `null` is a refusal, never a truncated path that would fail obscurely at bind time.
 */
export function pickTmuxTmpdirBase(
  bases: string[],
  uid: number,
  socket: string,
  prefix: string
): string | null {
  const dirName = prefix + 'X'.repeat(MKDTEMP_SUFFIX_LEN)
  return (
    bases.find((b) => tmuxSocketPath(path.join(b, dirName), uid, socket).length <= SUN_PATH_MAX) ??
    null
  )
}

/**
 * Create a private `TMUX_TMPDIR` that `-L <socket>` fits inside, and return it. Prefers the
 * platform temp dir and falls back to `/tmp`, which is what makes the difference on macOS: the
 * former resolves to `/private/var/folders/…` (56 characters), the latter to `/private/tmp` (12).
 *
 * Both candidates are resolved BEFORE they are measured — tmux resolves the symlink itself before
 * binding, so measuring the unresolved `/var/folders/…` under-counts by exactly the 8 characters
 * that overflowed.
 */
export function makeTmuxTmpdir(prefix: string, socket: string): string {
  const uid = process.getuid?.() ?? 0
  const bases = [...new Set([os.tmpdir(), '/tmp'].map(realpathOrSelf))]
  const base = pickTmuxTmpdirBase(bases, uid, socket, prefix)
  if (base === null) {
    throw new Error(
      `no temp dir leaves room for a tmux socket: tried ${bases.join(', ')} with prefix ` +
        `"${prefix}" and socket "${socket}" against ${SUN_PATH_MAX} chars`
    )
  }
  const dir = realpathOrSelf(fs.mkdtempSync(path.join(base, prefix)))
  const bound = tmuxSocketPath(dir, uid, socket)
  // Belt and braces: the prediction above and the directory mkdtemp actually made must agree, or
  // the suite fails here naming the number rather than at bind time naming the errno.
  if (bound.length > SUN_PATH_MAX) {
    throw new Error(`tmux socket path is ${bound.length} > ${SUN_PATH_MAX} chars: ${bound}`)
  }
  return dir
}

function realpathOrSelf(p: string): string {
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

// ── The run-wide sandbox (issue #629) ───────────────────────────────────────────────────────────
//
// The two helpers above serve a suite that ASKS for a private socket. Everything below serves the
// suites that do not: `test/setup/tmux-sandbox.ts` gives the whole vitest run one private
// `TMUX_TMPDIR`, so a test naming `node-terminal` binds inside the sandbox instead of on the server
// carrying the developer's live nodeterm canvas. They live here rather than beside the setup file
// because `src/core` is what the guard test can import — `test/` is outside every tsconfig project.

/** How the sandbox path reaches the workers, separately from `TMUX_TMPDIR` itself: a worker must be
 *  able to tell "this run set it up" from "the developer already had TMUX_TMPDIR exported". */
export const SANDBOX_ENV = 'NODETERM_TEST_TMUX_TMPDIR'

/**
 * Longest socket NAME the sandbox reserves room for.
 *
 * The sandbox is a PREFIX of every socket bound inside it, so it owes the same `SUN_PATH_MAX`
 * arithmetic as a per-suite directory. The real names are short (`node-terminal` is 13) but a suite
 * that binds `nt-accttest-<pid>` inside the sandbox needs the slack, and a budget discovered at
 * bind time reads like a broken test rather than a path-length limit.
 */
export const SANDBOX_SOCKET_BUDGET = 40

/** Point this process — and therefore every child and worker it spawns — at the sandbox. */
export function enterSandbox(sandbox: string): void {
  process.env[SANDBOX_ENV] = sandbox
  process.env.TMUX_TMPDIR = sandbox
  // A suite run from inside a nodeterm terminal inherits a live client's `TMUX`/`TMUX_PANE`.
  // Production strips both from every child it spawns for the same reason (nesting refusal); a test
  // that reads them would be measuring the developer's canvas.
  delete process.env.TMUX
  delete process.env.TMUX_PANE
}
