/**
 * Module-level WebGL context BUDGET coordinator.
 *
 * Chromium caps live WebGL contexts per process at ~16. When a page tries to exceed that cap the
 * browser force-EVICTS an existing context to make room — and that victim is sometimes a context
 * belonging to a terminal the user is currently looking at, which then paints as Chromium's
 * "lost context" dead-canvas placeholder (a white box with a sad-face icon) until our own
 * `onContextLoss` → dispose → DOM-fallback lands a beat later.
 *
 * The per-node IntersectionObserver decisions (acquire when visible, release after a delay when
 * hidden) are each individually correct but globally UN-coordinated: a fast pan across a
 * 30-terminal canvas, or zooming out past ~16 visible terminals, momentarily OVERSHOOTS the cap —
 * nodes panned away from keep their context for the release delay while newly visible nodes each
 * acquire immediately — so the browser force-evicts, and the dead placeholder flashes.
 *
 * This coordinator keeps the number of contexts WE hold at or under `WEBGL_BUDGET`, which sits
 * comfortably below the browser cap. If we never exceed it ourselves, the browser never has to
 * force-evict anyone, so the dead placeholder cannot appear. The coordinator owns ALL timing and
 * the grant decision; the per-node `acquire`/`release` callbacks stay dumb and idempotent.
 *
 * Grant rules:
 *  - A client that becomes visible is granted only after a short ACQUIRE DEBOUNCE
 *    (`WEBGL_ACQUIRE_DEBOUNCE_MS`), so a fast pan sweeping a node across the viewport for a couple
 *    of frames never acquires. (`rootMargin` on the observer already pre-announces approach.)
 *  - If granting would exceed the budget, the coordinator immediately RECLAIMS from the
 *    least-recently-visible HIDDEN holder (bypassing that holder's release delay). If every holder
 *    is currently visible (zoomed way out), the newcomer is NOT granted and stays on the DOM
 *    renderer. Either way we never push past the budget, so the browser never force-evicts.
 *  - A client that becomes hidden keeps its context for `WEBGL_RELEASE_DELAY_MS` (warm for a
 *    pan-back) but is the first reclaim candidate during that window.
 *  - `acquire()` returning false (WebGL2 unavailable / threw) does not count against the budget.
 *  - A context lost from outside (the addon's own `onContextLoss`) is reported via
 *    `handle.contextLost()`; the coordinator simply drops that grant from its accounting and does
 *    NOT auto-re-grant — the next visibility transition or reclaim decides.
 */

/** Ceiling on WebGL contexts we hold at once. Comfortably under Chromium's ~16-per-process cap. */
export const WEBGL_BUDGET = 12

/**
 * How long a client must stay continuously visible before it is granted a context. Absorbs fast
 * pans that sweep a node across the viewport for only a frame or two (which must not acquire).
 */
export const WEBGL_ACQUIRE_DEBOUNCE_MS = 150

/**
 * How long a client that scrolled out of the viewport keeps its context before the coordinator
 * releases it on its own. The context stays warm for a quick pan-back; a re-visible transition
 * within the window cancels the pending release. A hidden holder is also the first candidate to be
 * reclaimed on demand when a newly visible client needs a slot, bypassing this delay.
 */
export const WEBGL_RELEASE_DELAY_MS = 2000

export interface WebglClientCallbacks {
  /** Acquire the GPU context. Returns true on success, false if WebGL2 is unavailable / threw. */
  acquire(): boolean
  /** Release the GPU context. Must be idempotent (a no-op when nothing is held). */
  release(): void
}

export interface WebglClientHandle {
  /** Report this node's viewport visibility (driven by its IntersectionObserver). */
  setVisible(visible: boolean): void
  /** Report that the addon's own `onContextLoss` fired: drop this grant from the accounting. */
  contextLost(): void
  /** Node unmount: release any held context, cancel timers, and forget this client. */
  dispose(): void
}

interface Client {
  id: string
  acquire: () => boolean
  release: () => void
  visible: boolean
  /** Whether we believe this client currently holds a live context (counts against the budget). */
  granted: boolean
  acquireTimer: ReturnType<typeof setTimeout> | null
  releaseTimer: ReturnType<typeof setTimeout> | null
  /**
   * Monotonic tick recorded each time the client becomes hidden. Among hidden holders, the
   * SMALLEST value became hidden earliest (was visible least recently) → reclaimed first.
   */
  hiddenAt: number
}

const clients = new Map<string, Client>()

/** Monotonic clock for LRU ordering — independent of wall-clock / fake timers. */
let visibilityClock = 0

function grantCount(): number {
  let n = 0
  for (const c of clients.values()) if (c.granted) n++
  return n
}

function cancelAcquire(c: Client): void {
  if (c.acquireTimer) {
    clearTimeout(c.acquireTimer)
    c.acquireTimer = null
  }
}

function cancelRelease(c: Client): void {
  if (c.releaseTimer) {
    clearTimeout(c.releaseTimer)
    c.releaseTimer = null
  }
}

/** Release a client's context now, bypassing any pending release delay. */
function reclaim(c: Client): void {
  cancelRelease(c)
  if (!c.granted) return
  try {
    c.release()
  } catch {
    // release is best-effort; drop the grant regardless.
  }
  c.granted = false
}

/** The least-recently-visible HIDDEN holder, or null if every holder is currently visible. */
function lruHiddenHolder(): Client | null {
  let best: Client | null = null
  for (const c of clients.values()) {
    if (!c.granted || c.visible) continue
    if (!best || c.hiddenAt < best.hiddenAt) best = c
  }
  return best
}

function doGrant(c: Client): void {
  let ok = false
  try {
    ok = c.acquire()
  } catch {
    // acquire threw — treat as unavailable; do not count against the budget.
    ok = false
  }
  // A false / thrown acquire (WebGL2 unavailable) must NOT burn a slot: leave `granted` false.
  if (ok) c.granted = true
}

/** Attempt to grant `c` a context, reclaiming a hidden holder's slot if the budget is full. */
function tryGrant(c: Client): void {
  cancelAcquire(c)
  // Guard: the client may have gone hidden or been disposed between debounce start and fire.
  if (!clients.has(c.id) || !c.visible || c.granted) return
  if (grantCount() < WEBGL_BUDGET) {
    doGrant(c)
    return
  }
  // Full: reclaim the least-recently-visible hidden holder to free exactly one slot.
  const victim = lruHiddenHolder()
  if (!victim) {
    // Every holder is currently visible (zoomed way out): do not push past the budget. The
    // newcomer stays on the DOM renderer until a later visibility transition frees a slot.
    return
  }
  reclaim(victim)
  doGrant(c)
}

function setVisible(c: Client, visible: boolean): void {
  if (c.visible === visible) return
  c.visible = visible
  if (visible) {
    // Re-visible before the release fired: keep the warm context, cancel the pending release.
    cancelRelease(c)
    if (c.granted) return
    // Debounce the acquire so a fast pan-through never grabs a context for a two-frame flash.
    if (!c.acquireTimer) {
      c.acquireTimer = setTimeout(() => {
        c.acquireTimer = null
        tryGrant(c)
      }, WEBGL_ACQUIRE_DEBOUNCE_MS)
    }
    return
  }
  // Became hidden.
  c.hiddenAt = ++visibilityClock
  cancelAcquire(c)
  if (c.granted && !c.releaseTimer) {
    c.releaseTimer = setTimeout(() => {
      c.releaseTimer = null
      if (c.granted) {
        try {
          c.release()
        } catch {
          // best-effort
        }
        c.granted = false
      }
    }, WEBGL_RELEASE_DELAY_MS)
  }
}

/**
 * Register a terminal node as a WebGL client. The coordinator calls `acquire`/`release` to grant
 * or reclaim the GPU context; the node drives `handle.setVisible` from its IntersectionObserver,
 * reports external context loss via `handle.contextLost`, and calls `handle.dispose` on unmount.
 */
export function registerWebglClient(id: string, callbacks: WebglClientCallbacks): WebglClientHandle {
  // A re-register under the same id (e.g. a remount that raced teardown) supersedes the old entry.
  // Release a still-granted predecessor: its handle's dispose() will short-circuit (stale-handle
  // guard), so without this the old WebglAddon would leak a real browser context while the
  // coordinator forgets it held a slot — exactly the overshoot this module exists to prevent.
  const existing = clients.get(id)
  if (existing) {
    cancelAcquire(existing)
    cancelRelease(existing)
    if (existing.granted) {
      try {
        existing.release()
      } catch {
        // fail-open: a throwing release must not block the new registration
      }
      existing.granted = false
    }
  }
  const client: Client = {
    id,
    acquire: callbacks.acquire,
    release: callbacks.release,
    visible: false,
    granted: false,
    acquireTimer: null,
    releaseTimer: null,
    hiddenAt: 0
  }
  clients.set(id, client)

  return {
    setVisible(visible: boolean) {
      const c = clients.get(id)
      if (c === client) setVisible(c, visible)
    },
    contextLost() {
      const c = clients.get(id)
      if (c !== client) return
      // The browser (or our own dispose) already tore the context down; just drop the accounting.
      // Do NOT auto-re-grant — the next visibility transition or reclaim decides.
      cancelRelease(c)
      c.granted = false
    },
    dispose() {
      const c = clients.get(id)
      if (c !== client) return
      cancelAcquire(c)
      cancelRelease(c)
      if (c.granted) {
        try {
          c.release()
        } catch {
          // best-effort
        }
        c.granted = false
      }
      clients.delete(id)
    }
  }
}

/** Test-only: clear all coordinator state between cases. */
export function __resetWebglBudgetForTests(): void {
  for (const c of clients.values()) {
    cancelAcquire(c)
    cancelRelease(c)
  }
  clients.clear()
  visibilityClock = 0
}
