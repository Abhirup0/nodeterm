import type { DinoSnapshot } from '@shared/presence'

/**
 * The pure broadcast/spectate state machine behind {@link createDinoGame} — mode
 * (local authority vs. remote spectator), the ~20 Hz broadcast throttle, and the
 * single null-on-stop edge. Kept free of the DOM/canvas so it is unit-testable in a
 * plain node env (the game glue in dino-game.ts owns the rAF loop + drawing).
 */
export const DINO_BROADCAST_HZ = 20
export const DINO_BROADCAST_INTERVAL_MS = 1000 / DINO_BROADCAST_HZ

/** What a per-frame {@link DinoSync.tick} decides the caller should publish. */
export type DinoSyncEmit = 'snapshot' | 'null' | 'none'

export class DinoSync {
  private _mode: 'local' | 'remote' = 'local'
  private _remote: DinoSnapshot | null = null
  private lastEmit = 0
  /** True once we've published at least one snapshot for the current run, so we know
   *  a following idle/stop is a *transition* that owes exactly one null. */
  private broadcasting = false

  get mode(): 'local' | 'remote' {
    return this._mode
  }
  get remoteSnap(): DinoSnapshot | null {
    return this._remote
  }
  isRemote(): boolean {
    return this._mode === 'remote'
  }
  isAuthority(): boolean {
    return this._mode === 'local'
  }

  /**
   * Per-frame broadcast decision (call once per rAF frame in the local sim).
   * `active` = the run is in progress or on the game-over screen (`started || crashed`).
   * A spectator (remote mode) never broadcasts. An active run emits a snapshot at most
   * once per {@link DINO_BROADCAST_INTERVAL_MS} (first active frame emits immediately);
   * a return to idle emits a single null.
   */
  tick(now: number, active: boolean): DinoSyncEmit {
    if (this._mode === 'remote') return 'none'
    if (active) {
      if (!this.broadcasting || now - this.lastEmit >= DINO_BROADCAST_INTERVAL_MS) {
        this.lastEmit = now
        this.broadcasting = true
        return 'snapshot'
      }
      return 'none'
    }
    return this.endBroadcast()
  }

  /**
   * A hard stop edge (blur / stop() / destroy). Emits exactly one null iff we were
   * mid-broadcast, otherwise nothing — so null is never spammed. No-op while spectating.
   */
  endBroadcast(): DinoSyncEmit {
    if (this._mode === 'remote') return 'none'
    if (this.broadcasting) {
      this.broadcasting = false
      return 'null'
    }
    return 'none'
  }

  /**
   * Enter remote spectator mode with `snap`, or return to local authority with null.
   * Returns the emit owed by the transition: entering remote WHILE we were the authority
   * (e.g. we lost the lowest-clientId tiebreak) owes ONE `null` so our last snapshot stops
   * lingering on the hub — otherwise a third peer that later loses ITS authority could be
   * left watching our frozen frame forever. Any other transition owes nothing.
   */
  setRemote(snap: DinoSnapshot | null): DinoSyncEmit {
    if (snap) {
      const owed: DinoSyncEmit = this.broadcasting ? 'null' : 'none'
      this._mode = 'remote'
      this._remote = snap
      this.broadcasting = false // we stopped authoring; the owed null (if any) clears the hub
      return owed
    }
    this._mode = 'local'
    this._remote = null
    return 'none'
  }

  /**
   * Local input arrived while spectating → take over as authority. Flips to local mode
   * and returns the last remote snapshot to seed the sim from (for continuity), or null
   * if we were already the authority (a no-op). The next active frame re-broadcasts at once.
   */
  takeOver(): DinoSnapshot | null {
    if (this._mode !== 'remote') return null
    const seed = this._remote
    this._mode = 'local'
    this._remote = null
    this.broadcasting = false
    return seed
  }
}
