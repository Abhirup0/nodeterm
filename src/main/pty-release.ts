import type { IPty } from 'node-pty'

/** The subset of a node-pty terminal `releasePty` touches (destroy exists on UnixTerminal only). */
export type ReleasablePty = Pick<IPty, 'kill' | 'resume'> & { destroy?: () => void }

/**
 * Release a PTY client so its master fd is actually CLOSED, not just signalled.
 *
 * node-pty's `kill()` only sends SIGHUP to the child; the master fd is closed later, when the
 * socket reads EOF and emits 'close'. That never happens while the pty is `pause()`d — and our
 * xterm flow control pauses busy ptys — so a detach (`kill()`) of a paused session leaked one
 * /dev/ptmx fd per cycle until the main process hit its fd limit and every new spawn failed
 * with `posix_spawnp failed.`.
 *
 * `UnixTerminal.destroy()` closes the fd deterministically (and SIGHUPs the child once the
 * stream is down), so prefer it. `resume()` first so any already-pending EOF/'close' can flow;
 * fall back to `kill()` where destroy doesn't exist (e.g. the winpty backend).
 */
export function releasePty(proc: ReleasablePty): void {
  try {
    proc.resume()
  } catch {
    /* socket may already be closed */
  }
  try {
    if (typeof proc.destroy === 'function') proc.destroy()
    else proc.kill()
  } catch {
    /* process already dead (ESRCH) — nothing to release */
  }
}
