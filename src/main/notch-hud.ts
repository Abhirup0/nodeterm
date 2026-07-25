// macOS Notch HUD (docs/notch-hud.md) — a transparent, always-on-top, click-through strip along
// the top edge that shows walking agent mascots beside the MacBook notch while agents work, and
// expands into a mini session panel. macOS + desktop only; default on (settings.notchHud).
//
// This module owns the BrowserWindow + the getHudWindow/sendToHud singleton (mirroring
// main-window.ts) and the mirror/IPC subscriptions. The DATA folding lives in the pure,
// Electron-free notch-hud-model.ts so it is unit-testable without a window. index.ts feeds two
// extra streams in (the normalized agent-event stream for prompt+subagents, and context-update for
// the model) via the module-level notchHudOn* functions, which no-op when the HUD is off.

import { app, BrowserWindow, ipcMain, screen } from 'electron'
import { join } from 'path'
import { IPC } from '../shared/ipc'
import { getMainWindow, sendToMain } from './main-window'
import {
  onNodeStateChange,
  onNodeNowChange,
  onMirrorFlush,
  type NodeStateChange,
  type NodeNowChange,
  type MirrorFile
} from '../core/agent-status-mirror'
import type { NormalizedAgentEvent } from '../shared/agents/normalize'
import { createHudModel, type HudModel } from './notch-hud-model'

/** Minimum strip height when there is no physical notch (menu-bar height floor). */
const NOTCH_BAR_FLOOR = 24
/**
 * Assumed physical notch WIDTH (px). Electron exposes no `auxiliaryTopLeftArea`, so we assume a
 * centered notch of this width, and the capsule butts against its LEFT edge. Field-tuned to 168 px
 * (200 left a visible gap — the capsule sat too far left). TUNE ON A MAC: raise it to push the
 * capsule LEFT, lower it to slide the capsule RIGHT toward the notch.
 */
const NOTCH_WIDTH = 168
/** How long the panel must stay open before closing it counts as "read" (clears done latches). */
const PANEL_READ_MS = 700
/**
 * A top inset (`workArea.y - bounds.y`) at least this tall (px) means a PHYSICAL notch is present:
 * a notched Mac's menu bar is ~37 px, a notchless display's is ~24–25 px. Below this we treat the
 * display as notchless and draw a standalone floating pill instead of fusing to a notch. TUNABLE.
 */
const NOTCH_MIN_BAR = 32
/** Total window height — sized to the EXPANDED box (we never resize the frame; the renderer scales
 *  a CSS transform). Capped to the display height. */
const HUD_WINDOW_HEIGHT = 460
/** Debounce for coalescing feed changes into one push to the HUD renderer. */
const PUSH_DEBOUNCE_MS = 150
/** Low-frequency sweep so stale (gone + idle > 6h) nodes drop even with no live events. */
const SWEEP_MS = 10 * 60 * 1000

/**
 * Keep the app a REGULAR Dock app even though the HUD is a `focusable:false` (non-activating
 * panel) overlay. On macOS `focusable:false` maps to AppKit's `setDisableKeyOrMainWindow:YES`, so
 * the HUD window can never become the app's key/main window. If such a panel is the only window
 * that is orderFront-ed on screen (e.g. it shows before the main window has finished loading, or
 * while the main window is hidden by hide-on-close), macOS re-evaluates the app as having no
 * regular window and drops its Dock tile — the "Dock icon disappears once the HUD opens" bug.
 * Asserting `regular` + `dock.show()` is idempotent and cheap, and guarantees the HUD never
 * demotes the app's Dock presence. No-op off macOS.
 */
export function assertRegularDockPresence(): void {
  if (process.platform !== 'darwin') return
  try {
    // Idempotent: re-asserting 'regular' when already regular is a no-op.
    app.setActivationPolicy('regular')
  } catch {
    /* older Electron / transient — ignore */
  }
  // `dock.show()` returns a Promise in recent Electron; swallow it either way.
  try {
    void Promise.resolve(app.dock?.show()).catch(() => {})
  } catch {
    /* ignore */
  }
}

// ---- Singleton (mirror main-window.ts) -----------------------------------------------------

let hudWin: BrowserWindow | null = null

export function getHudWindow(): BrowserWindow | null {
  return hudWin && !hudWin.isDestroyed() ? hudWin : null
}

export function sendToHud(channel: string, ...args: unknown[]): void {
  getHudWindow()?.webContents.send(channel, ...args)
}

// ---- Controller ----------------------------------------------------------------------------

export interface NotchHudDeps {
  /** Sync in-memory node title (workspaceStore.getNodeTitle). */
  getNodeTitle: (nodeId: string) => string | undefined
}

class NotchHudController {
  private model: HudModel = createHudModel()
  private unsubs: (() => void)[] = []
  private pushTimer: ReturnType<typeof setTimeout> | null = null
  private sweepTimer: ReturnType<typeof setInterval> | null = null
  private ipcBound = false
  private readonly onSetIgnoreMouse: (_e: unknown, ignore: boolean) => void
  private readonly onFocusNode: (_e: unknown, nodeId: string) => void
  private readonly onExpanded: (_e: unknown, expanded: boolean) => void
  private readonly onDismiss: (_e: unknown, nodeId: string) => void
  /** When the panel was opened (epoch ms), 0 while collapsed — gates the read-clear below. */
  private panelOpenedAt = 0
  private readonly onDisplayChange: () => void

  constructor(private deps: NotchHudDeps) {
    this.onSetIgnoreMouse = (_e, ignore) => {
      // Ignore-mouse ON = click-through (the strip is transparent to the app beneath); OFF while the
      // pointer is over the hotspot/panel so clicks land. `forward` keeps move events flowing so the
      // renderer still sees pointer-leave to re-enable click-through.
      getHudWindow()?.setIgnoreMouseEvents(!!ignore, { forward: true })
    }
    this.onFocusNode = (_e, nodeId) => {
      if (typeof nodeId !== 'string' || !nodeId) return
      // Reuse the notification-click focus path: bring the main window forward + ask the renderer to
      // center the node, then clear its done highlight (a nodeterm-native "you looked at it").
      const w = getMainWindow()
      if (w) {
        if (w.isMinimized()) w.restore()
        w.show()
        w.focus()
        sendToMain(IPC.appFocusNode, nodeId)
      }
      this.model.noteFocus(nodeId)
      this.schedulePush()
    }
    this.onDismiss = (_e, nodeId) => {
      if (typeof nodeId !== 'string' || !nodeId) return
      this.model.dismiss(nodeId)
      this.schedulePush()
    }
    this.onExpanded = (_e, expanded) => {
      // The done latch clears when the panel CLOSES, not when it opens — and only after it was
      // open long enough to read (field bug: with hover-to-open the green blob vanished the instant
      // the pointer arrived, before anything could be read). So: hover, read, leave → it clears.
      if (expanded) {
        this.panelOpenedAt = Date.now()
        return
      }
      const openFor = this.panelOpenedAt ? Date.now() - this.panelOpenedAt : 0
      this.panelOpenedAt = 0
      if (openFor >= PANEL_READ_MS) {
        this.model.notePanelOpened()
        this.schedulePush()
      }
    }
    this.onDisplayChange = () => this.reposition()
  }

  start(): void {
    this.createWindow()
    this.bindIpc()
    this.unsubs.push(onNodeStateChange((c: NodeStateChange) => this.onModelChange(() => this.model.applyStateChange(c))))
    this.unsubs.push(onNodeNowChange((c: NodeNowChange) => this.onModelChange(() => this.model.applyNowChange(c))))
    this.unsubs.push(onMirrorFlush((doc: MirrorFile) => this.onModelChange(() => this.model.applyMirrorFlush(doc))))
    screen.on('display-metrics-changed', this.onDisplayChange)
    screen.on('display-added', this.onDisplayChange)
    screen.on('display-removed', this.onDisplayChange)
    this.sweepTimer = setInterval(() => {
      if (this.model.prune(Date.now())) this.schedulePush()
    }, SWEEP_MS)
    this.sweepTimer.unref?.()
  }

  stop(): void {
    for (const u of this.unsubs) {
      try {
        u()
      } catch {
        /* ignore */
      }
    }
    this.unsubs = []
    screen.removeListener('display-metrics-changed', this.onDisplayChange)
    screen.removeListener('display-added', this.onDisplayChange)
    screen.removeListener('display-removed', this.onDisplayChange)
    if (this.pushTimer) {
      clearTimeout(this.pushTimer)
      this.pushTimer = null
    }
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    this.unbindIpc()
    if (hudWin && !hudWin.isDestroyed()) hudWin.destroy()
    hudWin = null
  }

  /** Feed the normalized agent-event stream (prompt on newTurn + subagent grouping). */
  onAgentEvent(ev: NormalizedAgentEvent): void {
    this.onModelChange(() => this.model.applyAgentEvent(ev))
  }

  /** Feed a context-update {sessionId, model, usedPercent} (the model name). */
  onContextUpdate(p: { sessionId?: string; model?: string; usedPercent?: number }): void {
    this.onModelChange(() => this.model.applyContextUpdate(p))
  }

  private onModelChange(mutate: () => void): void {
    try {
      mutate()
    } catch {
      // A malformed event must never crash the HUD (or the main process).
      return
    }
    this.schedulePush()
  }

  private bindIpc(): void {
    if (this.ipcBound) return
    ipcMain.on(IPC.hudSetIgnoreMouse, this.onSetIgnoreMouse)
    ipcMain.on(IPC.hudFocusNode, this.onFocusNode)
    ipcMain.on(IPC.hudExpanded, this.onExpanded)
    ipcMain.on(IPC.hudDismiss, this.onDismiss)
    this.ipcBound = true
  }

  private unbindIpc(): void {
    if (!this.ipcBound) return
    ipcMain.removeListener(IPC.hudSetIgnoreMouse, this.onSetIgnoreMouse)
    ipcMain.removeListener(IPC.hudFocusNode, this.onFocusNode)
    ipcMain.removeListener(IPC.hudExpanded, this.onExpanded)
    ipcMain.removeListener(IPC.hudDismiss, this.onDismiss)
    this.ipcBound = false
  }

  private geometry(): {
    x: number
    y: number
    width: number
    height: number
    bar: number
    notchWidth: number
    notchCenterX: number
    hasNotch: boolean
  } {
    const d = screen.getPrimaryDisplay()
    const b = d.bounds
    const wa = d.workArea
    // The notch bar height is the strip between the display top and the usable work area
    // (menu-bar / notch). Floor at 24 so we always have room for the mascots.
    const inset = wa.y - b.y
    const bar = Math.max(NOTCH_BAR_FLOOR, inset)
    const height = Math.min(HUD_WINDOW_HEIGHT, b.height)
    // A physical notch is present only when the display actually has a menu bar (inset > 0) AND that
    // inset is as tall as a notched Mac's menu bar. Otherwise the renderer draws a floating pill.
    const hasNotch = inset > 0 && inset >= NOTCH_MIN_BAR
    return {
      x: b.x,
      y: b.y,
      width: b.width,
      height,
      bar,
      notchWidth: NOTCH_WIDTH,
      notchCenterX: Math.round(b.width / 2),
      hasNotch
    }
  }

  private reposition(): void {
    const w = getHudWindow()
    if (!w) return
    const g = this.geometry()
    w.setBounds({ x: g.x, y: g.y, width: g.width, height: g.height })
    this.schedulePush() // re-send geometry (bar can change with the notch/menu-bar)
  }

  private createWindow(): void {
    if (getHudWindow()) return
    const g = this.geometry()
    const win = new BrowserWindow({
      x: g.x,
      y: g.y,
      width: g.width,
      height: g.height,
      frame: false,
      transparent: true,
      hasShadow: false,
      resizable: false,
      movable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      alwaysOnTop: true,
      focusable: false,
      skipTaskbar: true,
      show: false,
      // LOAD-BEARING (field bug: the capsule rendered as a detached black box BELOW the menu bar
      // instead of fused with the notch). AppKit's -[NSWindow constrainFrameRect:toScreen:] pushes
      // every window down so it can't overlap the menu bar / notch strip; Electron only skips that
      // constraint when enableLargerThanScreen is set. Without it our y = display.bounds.y request
      // is silently clamped to workArea.y and the window can never paint over the notch.
      enableLargerThanScreen: true,
      // NSPanel (non-activating), the same window class agent-notch uses for its indicator: floats
      // over fullscreen spaces and never takes key/main.
      type: 'panel',
      // Do not steal the space or animate; it is a passive overlay.
      acceptFirstMouse: true,
      backgroundColor: '#00000000',
      webPreferences: {
        preload: join(__dirname, '../preload/hud.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false
      }
    })
    hudWin = win
    // Float above full-screen apps and every Space; screen-saver level keeps it over normal windows.
    win.setAlwaysOnTop(true, 'screen-saver')
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    // Passive by default: the strip is click-through; the renderer flips this OFF over the hotspot.
    win.setIgnoreMouseEvents(true, { forward: true })
    // The HUD must NEVER affect the Dock: this is a regular Dock app. Creating a focusable:false
    // panel can otherwise demote the app to accessory and drop the Dock icon — re-assert here.
    assertRegularDockPresence()

    win.on('closed', () => {
      if (hudWin === win) hudWin = null
    })

    const devUrl = process.env['ELECTRON_RENDERER_URL']
    if (devUrl) {
      void win.loadURL(`${devUrl}/hud.html`)
    } else {
      void win.loadFile(join(__dirname, '../renderer/hud.html'))
    }
    win.webContents.on('did-finish-load', () => {
      win.showInactive() // show without stealing focus
      // Showing the panel is exactly when macOS re-evaluates the app's window set — re-assert the
      // regular Dock policy so the freshly-shown non-activating panel can't demote us to accessory.
      assertRegularDockPresence()
      this.pushNow()
    })
  }

  private schedulePush(): void {
    if (this.pushTimer) return
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null
      this.pushNow()
    }, PUSH_DEBOUNCE_MS)
    this.pushTimer.unref?.()
  }

  private pushNow(): void {
    const w = getHudWindow()
    if (!w) return
    const now = Date.now()
    this.model.prune(now)
    const rows = this.model.buildRows(now, this.deps.getNodeTitle)
    const g = this.geometry()
    // Did AppKit still push us below the menu bar despite enableLargerThanScreen (older macOS, an
    // unusual display arrangement)? Then the window CANNOT paint over the notch, and reserving the
    // fused top strip would only make the capsule a tall detached box — the exact field bug. Tell
    // the renderer so it drops the reserved strip and draws a compact pill instead.
    const clamped = w.getBounds().y > g.y
    w.webContents.send(IPC.hudRows, {
      rows,
      bar: g.bar,
      width: g.width,
      notchWidth: g.notchWidth,
      notchCenterX: g.notchCenterX,
      hasNotch: g.hasNotch && !clamped
    })
  }
}

// ---- Module-level lifecycle + feed shims ---------------------------------------------------

let controller: NotchHudController | null = null
let controllerDeps: NotchHudDeps | null = null

/** Whether the HUD is supported on this platform (macOS desktop only). */
function supported(): boolean {
  return process.platform === 'darwin'
}

/**
 * Create the HUD (if darwin + enabled). Idempotent. `deps.getNodeTitle` is retained so a later
 * `setNotchHudEnabled(true)` (settings toggle) can recreate it without re-plumbing.
 */
export function initNotchHud(deps: NotchHudDeps, enabled: boolean): void {
  controllerDeps = deps
  if (!supported() || !enabled) return
  if (controller) return
  controller = new NotchHudController(deps)
  controller.start()
}

/** Live settings toggle: create or destroy the HUD window without a restart. */
export function setNotchHudEnabled(enabled: boolean): void {
  if (!supported()) return
  if (enabled) {
    if (controller || !controllerDeps) return
    controller = new NotchHudController(controllerDeps)
    controller.start()
  } else {
    controller?.stop()
    controller = null
  }
}

/** Tear the HUD down (app quit). */
export function destroyNotchHud(): void {
  controller?.stop()
  controller = null
}

/** Feed shims — cheap no-ops when the HUD is off. Called unconditionally from index.ts. */
export function notchHudOnAgentEvent(ev: NormalizedAgentEvent): void {
  controller?.onAgentEvent(ev)
}
export function notchHudOnContextUpdate(p: {
  sessionId?: string
  model?: string
  usedPercent?: number
}): void {
  controller?.onContextUpdate(p)
}
