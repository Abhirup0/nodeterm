import fs from 'fs'

/**
 * What the process had left when a spawn failed.
 *
 * `null` anywhere means "could not be measured", which is a different statement from zero and is
 * rendered as silence rather than as a number — a diagnostic that invents a figure is worse than
 * one that admits it does not know.
 */
export interface SpawnResources {
  /** Open file descriptors right now. */
  openFds: number | null
  /** The process's own RLIMIT_NOFILE, soft — the one that actually bites. */
  fdSoft: number | null
  /** RLIMIT_NPROC, soft. */
  procSoft: number | null
}

/**
 * How close to a limit counts as "at" it.
 *
 * A spawn needs several descriptors at once (the pty master, the slave, the helper's pipes), so a
 * process sitting a handful below its ceiling is already the cause even though the number is not
 * literally equal. Deliberately generous in the direction of NAMING the limit: the cost of saying
 * "you are out of file descriptors" when the true cause was something else is a wrong sentence in
 * an error message; the cost of staying silent is the user re-running `npm run rebuild` for the
 * third time, which is exactly what the old message told them to do.
 */
const NEAR_LIMIT = 16

/**
 * Measure what a failed spawn ran out of.
 *
 * node-pty reports every failure as a bare `posix_spawnp failed.` with the errno discarded, so the
 * one thing that would answer this immediately — EMFILE vs EAGAIN vs ENOENT — never reaches us.
 * These two numbers are the closest thing available, and they are cheap: a directory listing and a
 * field already inside Node's own report.
 *
 * `/dev/fd` is the descriptor list on macOS AND on Linux (where it is a symlink to
 * `/proc/self/fd`), which is why it is read directly rather than branched on platform. Note the
 * listing itself holds a descriptor while it runs, so the count is honest to within one.
 *
 * Fail-open in every direction: this runs INSIDE an error path, and a diagnostic that throws would
 * replace a bad error message with no error message at all.
 */
export function readSpawnResources(): SpawnResources {
  let openFds: number | null = null
  try {
    openFds = fs.readdirSync('/dev/fd').length
  } catch {
    openFds = null
  }
  let fdSoft: number | null = null
  let procSoft: number | null = null
  try {
    const limits = (
      process.report?.getReport() as {
        userLimits?: Record<string, { soft?: number | string }>
      }
    )?.userLimits
    const soft = (key: string): number | null => {
      const v = limits?.[key]?.soft
      return typeof v === 'number' && Number.isFinite(v) ? v : null
    }
    fdSoft = soft('open_files')
    procSoft = soft('max_user_processes')
  } catch {
    /* diagnostics only */
  }
  return { openFds, fdSoft, procSoft }
}

/**
 * The sentence to append to a spawn failure — the measurement, and a remedy that FOLLOWS from it.
 *
 * Pure, so the wording can be pinned. What it must never do is repeat the old message's mistake:
 * that one always advised restarting the app or rebuilding node-pty for the wrong architecture,
 * which is a real cause but a rare one, and it read as authoritative. When the numbers say the
 * process is out of file descriptors, say THAT; when they say nothing, say nothing and leave the
 * generic advice as what it is — a guess of last resort.
 */
export function spawnResourceNote(r: SpawnResources, livePtys: number): string {
  const parts: string[] = [`live PTYs: ${livePtys}`]
  if (r.openFds !== null) {
    parts.push(`open files: ${r.openFds}${r.fdSoft !== null ? `/${r.fdSoft}` : ''}`)
  } else if (r.fdSoft !== null) {
    parts.push(`file limit: ${r.fdSoft}`)
  }
  const outOfFds = r.openFds !== null && r.fdSoft !== null && r.openFds >= r.fdSoft - NEAR_LIMIT
  const measured = parts.join(', ')
  if (outOfFds) {
    return (
      `${measured}. This process is at its FILE DESCRIPTOR limit, which is what stopped the ` +
      `spawn — close some terminals (or raise the limit) rather than restarting; a restart frees ` +
      `them but they fill up again.`
    )
  }
  return measured
}
