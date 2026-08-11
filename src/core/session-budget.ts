// Session budget: reap long-idle DETACHED nt- tmux sessions under memory pressure (or past a
// count cap), so abandoned agent sessions can't accumulate until the host swaps itself to death
// (field report: 95 sessions / 34 GB of idle claude processes on one host).
//
// This is the tmux counterpart of the renderer's WebGL budget (`terminal/webgl-budget.ts`), and it
// deliberately reuses that design's rules rather than inventing an expiry policy:
//   - a bounded budget, enforced only when exceeded — never a calendar-based expiry;
//   - eviction picks the LEAST-RECENTLY-ACTIVE holder;
//   - an ATTACHED session (someone is looking at it) is never evicted, exactly like a visible
//     WebGL holder; a recently-active one is protected by a grace window (the release delay).
//     "Attached" means a WATCHER: this app's own control-mode shadows are tmux clients too, and
//     they are subtracted from tmux's flag via the `shadowed` seam — see SessionReaperOpts;
//   - reaping is gradual (per-sweep batch), so one sweep can never mass-kill its way past the
//     target — the next sweep re-evaluates.
//
// Killing a detached session is safe BECAUSE of the cold-restore contract: to the node, a reap is
// indistinguishable from a machine reboot. On next open `tmux has-session` fails → fresh=true →
// the renderer replays the scrollback snapshot and re-launches a resumable agent
// (`claude --resume …`). For that to hold, the reaper must kill ONLY the tmux session: it must
// never delete scrollback snapshots and never write a pty-manager tombstone (both belong to the
// user-deletes-the-node path, `destroySession`).
//
// Electron-free (src/core): all exec/mem/clock access is behind injectable seams (template:
// ack-sweep.ts), so both shells boot it and tests drive it without touching tmux.

import fs from 'fs'
import os from 'os'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { TMUX_SOCKET } from './tmux-naming'
import { RMT_TMUX_SOCKET } from './remote-ssh/control-master'

const runAsync = promisify(execFile)

/** One tmux session as reported by `list-sessions`. `activitySec` is epoch seconds. */
export interface SessionInfo {
  name: string
  /**
   * How many clients tmux reports attached. A COUNT, not a flag: `#{session_attached}` is the
   * number of clients, and one session can have several — the app's painter, the user's own `tmux
   * -L node-terminal attach`, a second nodeterm process on the same socket, one of our
   * control-mode shadows.
   *
   * Carried numerically rather than collapsed to a boolean at parse time because the `shadowed`
   * seam SUBTRACTS: a session holding our shadow AND a real client must still read as attached,
   * and a boolean can only be forced to false — which would reap the session out from under
   * whoever the other client belongs to.
   */
  clients: number
  activitySec: number
}

/** Host memory snapshot in MB. `null` from a reader means "could not read" — see planReap. */
export interface MemInfo {
  availableMb: number
  totalMb: number
}

export interface SessionBudgetConfig {
  /** Kill switch (`NODETERM_SESSION_REAP_DISABLED=1`): sweeps become no-ops. */
  disabled: boolean
  /** Watermark: reap only while host available memory is BELOW this (primary trigger). */
  minAvailableMb: number
  /** Backstop: max detached nt- sessions across sockets; excess is reaped even without pressure. */
  maxDetached: number
  /** A session with activity newer than this is never reaped (protects same-day project switches). */
  graceSec: number
  /** Max kills per sweep — convergence is gradual and re-evaluated each sweep. */
  batchMax: number
}

function envInt(env: NodeJS.ProcessEnv, key: string, fallback: number): number {
  const n = Number(env[key])
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback
}

/**
 * Defaults, overridable per host via env (systemd `Environment=` lines):
 *   NODETERM_SESSION_MIN_AVAILABLE_MB  (default: 10% of total RAM, floor 1 GB)
 *   NODETERM_SESSION_MAX_DETACHED     (default: 48)
 *   NODETERM_SESSION_GRACE_HOURS      (default: 6)
 *   NODETERM_SESSION_REAP_BATCH       (default: 8)
 *   NODETERM_SESSION_REAP_DISABLED=1  (kill switch)
 */
export function sessionBudgetConfig(env: NodeJS.ProcessEnv, totalMb: number): SessionBudgetConfig {
  return {
    disabled: env.NODETERM_SESSION_REAP_DISABLED === '1' || env.NODETERM_SESSION_REAP_DISABLED === 'true',
    minAvailableMb: envInt(env, 'NODETERM_SESSION_MIN_AVAILABLE_MB', Math.max(1024, Math.round(totalMb * 0.1))),
    maxDetached: envInt(env, 'NODETERM_SESSION_MAX_DETACHED', 48),
    graceSec: envInt(env, 'NODETERM_SESSION_GRACE_HOURS', 6) * 3600,
    batchMax: envInt(env, 'NODETERM_SESSION_REAP_BATCH', 8)
  }
}

/**
 * Pure policy: which sessions to kill this sweep, least-recently-active first.
 *
 * Eligible = named `nt-*` AND detached AND idle past the grace window. Then:
 *   - memory below the watermark → up to `batchMax` (a failed memory read — `mem === null` — is
 *     NOT pressure: absence of evidence never triggers the primary path);
 *   - detached count over `maxDetached` → the excess, even with healthy memory;
 * combined take is bounded by `batchMax`.
 */
export function planReap(
  sessions: SessionInfo[],
  mem: MemInfo | null,
  nowSec: number,
  cfg: SessionBudgetConfig
): string[] {
  if (cfg.disabled) return []
  const nt = sessions.filter((s) => s.name.startsWith('nt-'))
  const detached = nt.filter((s) => s.clients === 0)
  const eligible = detached
    .filter((s) => nowSec - s.activitySec >= cfg.graceSec)
    .sort((a, b) => a.activitySec - b.activitySec)

  const pressure = mem !== null && mem.availableMb < cfg.minAvailableMb ? cfg.batchMax : 0
  const overCap = Math.max(0, detached.length - cfg.maxDetached)
  const take = Math.min(cfg.batchMax, Math.max(pressure, overCap))
  return eligible.slice(0, take).map((s) => s.name)
}

/** Parse `list-sessions -F '#{session_name}|#{session_attached}|#{session_activity}'` output.
 *  Tolerant: malformed lines are skipped, never thrown on. */
export function parseSessionList(stdout: string): SessionInfo[] {
  const out: SessionInfo[] = []
  for (const line of stdout.split('\n')) {
    const parts = line.trim().split('|')
    if (parts.length !== 3) continue
    const attached = Number(parts[1])
    const activity = Number(parts[2])
    if (!parts[0] || !Number.isFinite(attached) || !Number.isFinite(activity)) continue
    out.push({ name: parts[0], clients: Math.max(0, attached), activitySec: activity })
  }
  return out
}

/** Linux `/proc/meminfo` (MemAvailable is the honest number); `os.freemem()` fallback elsewhere.
 *  Returns null when nothing readable — the policy treats that as "no pressure signal". */
export function readMemInfo(): MemInfo | null {
  try {
    const text = fs.readFileSync('/proc/meminfo', 'utf8')
    const avail = /MemAvailable:\s+(\d+)\s*kB/.exec(text)
    const total = /MemTotal:\s+(\d+)\s*kB/.exec(text)
    if (avail && total) {
      return { availableMb: Math.round(Number(avail[1]) / 1024), totalMb: Math.round(Number(total[1]) / 1024) }
    }
  } catch {
    // fall through to the os fallback
  }
  try {
    return { availableMb: Math.round(os.freemem() / 1048576), totalMb: Math.round(os.totalmem() / 1048576) }
  } catch {
    return null
  }
}

export interface SessionReaperOpts {
  /** Lazy tmux binary resolver (PtyManager resolves after init; null = tmux unavailable → no-op). */
  tmuxBin: () => string | null
  /** tmux sockets to sweep. Default: the local socket + the SSH-remote socket — a host that serves
   *  SSH projects accumulates sessions on `nodeterm-rmt`, and its own nodeterm-server (this
   *  process) is the natural owner of reaping them; the desktops that spawned them may be gone. */
  sockets?: string[]
  /**
   * The tmux sessions THIS process holds a control-mode SHADOW on, per socket (see
   * `PtyManager.shadowedTmuxSessions`). They are reported as DETACHED regardless of what tmux says,
   * in the plan AND in the kill-time re-verify.
   *
   * A shadow is a real tmux client, so a held `-C attach` flips `#{session_attached}` to 1 — and an
   * attached session is never evicted here. Without this hook, attaching a shadow (something no
   * user asked for and nobody is watching) would make a session permanently exempt from the
   * memory-pressure safety valve this whole module exists to be. A shadow is not a watcher: the
   * session may be reaped under it exactly as if nothing were attached, and the shadow's client
   * dies with the session it was attached to.
   *
   * Per SOCKET, not per name: `nt-<node>` is only unique within a socket, and a genuinely attached
   * session of the same name on `nodeterm-rmt` must keep its exemption.
   */
  shadowed?: (socket: string) => Iterable<string>
  exec?: (bin: string, args: string[]) => Promise<string>
  readMem?: () => MemInfo | null
  env?: NodeJS.ProcessEnv
  nowSec?: () => number
  intervalMs?: number
  log?: (msg: string) => void
}

export interface SessionReaper {
  /** One sweep; resolves to the number of sessions killed. Never throws. */
  sweep(): Promise<number>
  start(): void
  stop(): void
}

export const SESSION_SWEEP_INTERVAL_MS = 10 * 60_000

/**
 * Periodic reaper over the injectable seams. Failure rules (CLAUDE.md: a failed read is never
 * evidence of absence): a socket whose `list-sessions` fails contributes NO candidates — only a
 * successful listing can put a session on the kill list, and the kill is re-verified against a
 * FRESH listing at kill time (a session that got attached between plan and kill is spared).
 */
export function createSessionReaper(opts: SessionReaperOpts): SessionReaper {
  const sockets = opts.sockets ?? [TMUX_SOCKET, RMT_TMUX_SOCKET]
  const exec =
    opts.exec ??
    (async (bin: string, args: string[]): Promise<string> => {
      const { stdout } = await runAsync(bin, args, { timeout: 15_000 })
      return stdout
    })
  const readMem = opts.readMem ?? readMemInfo
  const env = opts.env ?? process.env
  const nowSec = opts.nowSec ?? ((): number => Math.floor(Date.now() / 1000))
  const log = opts.log ?? ((m: string): void => console.log(m))
  const cfg = sessionBudgetConfig(env, readMem()?.totalMb ?? Math.round(os.totalmem() / 1048576))

  const LIST_FMT = '#{session_name}|#{session_attached}|#{session_activity}'

  const listSocket = async (bin: string, socket: string): Promise<SessionInfo[] | null> => {
    try {
      const listed = parseSessionList(await exec(bin, ['-L', socket, 'list-sessions', '-F', LIST_FMT]))
      // Our own shadows are subtracted from tmux's client COUNT here, at the one place every
      // listing comes through, so the plan and the kill-time re-verify can never disagree about it
      // (a shadow attached between the two would otherwise resurrect the exemption). Re-read each
      // time: the set changes as sessions are shadowed and swapped back to painters.
      //
      // Minus ONE client, never "detached": this app holds at most one shadow per session, and
      // anything left over is somebody else's client — the user's own `tmux attach`, another
      // nodeterm process on this socket — whose session must keep the exemption. Forcing the flag
      // false here would reap a session out from under a live user.
      const shadowed = new Set(opts.shadowed?.(socket) ?? [])
      if (shadowed.size === 0) return listed
      return listed.map((s) =>
        s.clients > 0 && shadowed.has(s.name) ? { ...s, clients: s.clients - 1 } : s
      )
    } catch {
      // "no server running" and a real failure both land here; neither yields candidates.
      return null
    }
  }

  const sweep = async (): Promise<number> => {
    if (cfg.disabled) return 0
    const bin = opts.tmuxBin()
    if (!bin) return 0

    const bySocket = new Map<string, SessionInfo[]>()
    for (const s of sockets) {
      const listed = await listSocket(bin, s)
      if (listed) bySocket.set(s, listed)
    }
    if (bySocket.size === 0) return 0

    const all = [...bySocket.entries()].flatMap(([, list]) => list)
    const plan = new Set(planReap(all, readMem(), nowSec(), cfg))
    if (plan.size === 0) return 0

    let killed = 0
    for (const [socket, listed] of bySocket) {
      const names = listed.filter((s) => plan.has(s.name)).map((s) => s.name)
      if (names.length === 0) continue
      // Kill-time re-verify on a FRESH list: only sessions still present and still detached die.
      const fresh = await listSocket(bin, socket)
      if (!fresh) continue
      const stillDetached = new Set(fresh.filter((s) => s.clients === 0).map((s) => s.name))
      for (const name of names) {
        if (!stillDetached.has(name)) continue
        try {
          // `=` forces an exact target match — never tmux's prefix matching.
          await exec(bin, ['-L', socket, 'kill-session', '-t', `=${name}`])
          killed++
          log(`[session-budget] reaped idle detached session ${name} (socket ${socket})`)
        } catch {
          // A vanished-in-between session or a kill failure changes nothing; next sweep re-plans.
        }
      }
    }
    return killed
  }

  let timer: ReturnType<typeof setInterval> | null = null
  return {
    sweep,
    start(): void {
      if (timer) return
      timer = setInterval(() => void sweep(), opts.intervalMs ?? SESSION_SWEEP_INTERVAL_MS)
      timer.unref?.()
    },
    stop(): void {
      if (timer) {
        clearInterval(timer)
        timer = null
      }
    }
  }
}
