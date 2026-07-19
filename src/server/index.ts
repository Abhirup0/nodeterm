import fs from 'fs'
import path from 'path'
import http from 'http'

import { ServerPlatform } from './platform-server'
import { Auth } from './auth'
import { createHttpHandler } from './http'
import { attachWsServer } from './ws'
import type { ServerConfig } from './config'

import { initPlatform } from '../core/platform'
import { SettingsStore } from '../core/settings-store'
import { WorkspaceStore } from '../core/workspace-store'
import { PtyManager } from '../core/pty-manager'
import { registerCoreHandlers } from './handlers'
import { hookServer } from '../core/agents/hook-server'
import { installManagedAgentHooks } from '../core/agents/hooks'
import {
  initAgentStatusMirror,
  flush as flushAgentStatusMirror,
  setMirrorSettingsProvider,
  type MirrorSettings
} from '../core/agent-status-mirror'
import { claudeCliCaps, type ClaudeCliCaps } from '../core/claude-cli'
import { claudeConfigDirFor } from '../core/claude-config-dir'
import { presenceHub } from '../core/presence/hub'
import { initCanvasSync } from '../core/canvas-sync'
import { wireAgentStatus } from './agent-status'
import { IPC } from '@shared/ipc'
import { WhisperModelStore } from '../core/speech/whisper-models'
import { SpeechService } from '../core/speech/speech-service'
import { registerSpeechIpc } from '../core/speech/register-ipc'
import { isPremium, getStoredEntitlement } from '../core/license'

// Same env-override + default as src/core/check.ts / license.ts / src/main/telemetry.ts — each
// shell derives it locally rather than sharing an import (src/server must not import src/main).
const API_BASE = process.env.NODETERM_API_BASE || 'https://api.nodeterm.dev'

/**
 * App version fed to ServerPlatform (surfaced to the renderer as the desktop app's
 * `app.getVersion()` equivalent). Read from package.json at boot; the esbuild bundle
 * lives at `out/server/main.cjs`, so `../../package.json` resolves to the repo root.
 * Falls back to '0.0.0' if the file can't be read (never fatal).
 */
function readAppVersion(): string {
  try {
    const pkgPath = path.join(__dirname, '../../package.json')
    const parsed = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string }
    return parsed.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

/**
 * Boot the headless server: wires the CorePlatform (ServerPlatform) to auth + HTTP +
 * WebSocket, then constructs and registers the same core services the desktop main
 * process uses (SettingsStore / PtyManager / WorkspaceStore), mirroring
 * `src/main/index.ts`'s construction + registration order.
 *
 * Returns the actually-bound port (so port 0 works in tests) and a `close()` that
 * detaches PTY clients (tmux sessions keep running — Phase 1 contract) and stops the server.
 */
export async function startServer(
  config: ServerConfig
): Promise<{ port: number; close(): Promise<void> }> {
  fs.mkdirSync(config.dataDir, { recursive: true })

  // Core platform boundary — must be initialized before any core service registers handlers.
  const platform = new ServerPlatform({
    userDataDir: config.dataDir,
    appVersion: readAppVersion()
  })
  initPlatform(platform)

  const auth = new Auth(config.dataDir)
  if (config.passwordSeed && !auth.isConfigured()) auth.setPassword(config.passwordSeed)
  if (!auth.isConfigured()) {
    // No password set yet: print the one-time setup URL so the operator can bootstrap.
    console.log(`Setup: http://${config.host}:${config.port}/setup?token=${auth.setupToken()}`)
  }

  // Core services — same construction + registration order as src/main/index.ts.
  const settingsStore = new SettingsStore()
  const ptyManager = new PtyManager()
  const workspaceStore = new WorkspaceStore()

  settingsStore.init()
  settingsStore.registerIpc()
  ptyManager.init(() => settingsStore.get())
  ptyManager.registerIpc()
  workspaceStore.registerIpc()
  // Dictation: same construction as src/main/index.ts, with the server's data dir. onProgress
  // broadcasts to every attached browser tab the same way wireAgentStatus pushes agent-status.
  const whisperModels = new WhisperModelStore({
    dir: path.join(config.dataDir, 'speech-models'),
    onProgress: (id, pct) => platform.broadcast(IPC.speechProgress, { id, pct })
  })
  const speechService = new SpeechService({ models: whisperModels, isPremium })
  registerSpeechIpc({
    handle: (channel, fn) => platform.handle(channel, fn),
    service: speechService,
    models: whisperModels,
    settings: () => settingsStore.get(),
    licenseToken: () => getStoredEntitlement(),
    apiBase: API_BASE
  })
  // Browser mic permission is the browser's own prompt (getUserMedia), not ours to gate —
  // unlike Electron's systemPreferences.askForMediaAccess, there is nothing server-side to ask.
  platform.handle(IPC.speechMicConsent, async () => true)
  // Canvas sync: reflect each browser tab's node mutations to the other attached tabs, so every
  // client converges on the same node set (and no tab writes back a node another tab deleted).
  initCanvasSync()
  // Team presence (hello / cursor / focus / chat). The hub itself is joined per WebSocket in
  // ws.ts; this only registers the RPC surface. Presence is transient — nothing is persisted.
  presenceHub.registerIpc()

  // WS backpressure: when a connection's socket send buffer fills while streaming pty
  // output, pause that tmux client so the OS pipe applies real backpressure (resumes below
  // the low-water mark). See platform-server.ts sendTo.
  //
  // The pause is attributed to the UI whose socket is backed up (`uiId`) — so PtyManager's ledger
  // (Session.pausedBy) returns it when that UI drains OR when it disconnects, and one backed-up
  // browser can no longer be un-paused by another browser's join/leave.
  //
  // It is booked under the 'socket' OWNER, not the same ticket as the pause that UI's own renderer
  // casts over `pty:flow`. The two queues are different and drain at different times — the socket
  // empties as fast as the browser reads bytes, the renderer's xterm backlog only as fast as it
  // parses them — so sharing one ticket would let the socket's drain (sweepPaused) hand back the
  // pause the renderer still owes. The renderer's flow control is edge-latched and would never
  // re-pause: its backlog would then grow at network speed for the rest of the flood.
  platform.setFlowController((uiId, sid, resume, owner) =>
    ptyManager.setFlow(uiId, sid, resume, owner)
  )

  // Bounded memory: a client whose socket backlog we discarded (WS_DROP_WATER) is REDRAWN from
  // tmux — the current screen — rather than replayed. See platform-server.ts dropOrDesync.
  platform.setResyncProvider((sid) => ptyManager.captureForResync(sid))

  // Desktop's src/main/index.ts registers a few pty handlers outside PtyManager. Of those,
  // ptyCapture delegates purely to core (ptyManager.captureSession), so it belongs here.
  // The others (ptyGenerateName / ptyGenerateGroupName → commit-message.ts; ptyReadSessionName
  // → transcript-reader.ts) depend on src/main-resident modules and are stubbed by the bridge
  // in Task 8. readScrollback + sendText are already registered inside PtyManager.registerIpc().
  platform.handle(IPC.ptyCapture, (persistKey: string, full?: boolean) =>
    ptyManager.captureSession(persistKey, full)
  )

  // fs + git + commit handlers (shared with desktop core services).
  registerCoreHandlers(platform, { getSettings: () => settingsStore.get() })

  // Agent status pipeline — mirrors the desktop boot order in src/main/index.ts:
  // mirror-init → wire the hook-server listeners onto the platform → install the managed hook
  // scripts → start the loopback hook server. The hook server binds its own port independent of
  // the main HTTP server below.
  initAgentStatusMirror()
  // Advertise launch settings to the mobile companion through the mirror (same provider the
  // desktop wires in src/main/index.ts). No SSH push exists server-side, so only the local
  // provider applies. The provider is consulted at every flush (heartbeat ≤60s), so a settings
  // change propagates without extra plumbing. Caps arrive async: re-flush once the memoized
  // probe answers.
  let localClaudeCaps: ClaudeCliCaps | undefined
  void claudeCliCaps()
    .then((c) => {
      localClaudeCaps = c
      void flushAgentStatusMirror()
    })
    .catch(() => {})
  setMirrorSettingsProvider((): MirrorSettings => {
    const s = settingsStore.get()
    return {
      claudePermissionMode: s.claudePermissionMode,
      autoSupported: localClaudeCaps?.autoPermissionMode === true,
      claudeAccounts: (s.claudeAccounts ?? [])
        .filter((a) => !a.host && !a.pending)
        .map((a) => ({ id: a.id, dir: claudeConfigDirFor(a.id) }))
    }
  })
  wireAgentStatus(platform)
  // Desktop → paired-phone APNs push (spec: apns-push) is DELIBERATELY not wired here. The push
  // service (`src/core/push-notify.ts`) fans actionable inbox events out to a host's relay-PAIRED
  // phones, keyed by the standing relay host's identity (public key + hostDeviceId) and the
  // pinned-device registry. The Server Edition has no standing relay host — no host keypair, no
  // approved-devices store, no host-token mint (all live in src/main/remote/) — so there is no
  // identity to sign the fan-out and no paired-phone list to reach. A phone talks to a server-
  // edition host over SSH and keeps polling the mirror. So the service would be permanently inert
  // here; we leave it unwired rather than construct a no-op. (Three-surfaces rule: documented
  // desktop-only.)
  // `installHooks: false` (tests) skips the merge into the user's real ~/.claude et al —
  // the hook it would write points into `dataDir`, which a test then deletes.
  if (config.installHooks !== false) {
    try {
      // Fail-open: installManagedAgentHooks is itself best-effort, but a throw must never block boot.
      installManagedAgentHooks()
    } catch (e) {
      console.warn('[nodeterm-server] managed hook install failed', e)
    }
  }
  await hookServer.start()

  const server = http.createServer(createHttpHandler({ auth, rendererDir: config.rendererDir }))
  // A closed browser tab is the NORMAL way to leave the Server Edition and sends no `pty:kill`,
  // so the WS close hook is what unsubscribes that client from the sessions it was watching.
  attachWsServer(server, { platform, auth, onClientGone: (uiId) => ptyManager.dropClient(uiId) })

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, config.host, () => {
      server.off('error', reject)
      resolve()
    })
  })

  const addr = server.address()
  const port = addr && typeof addr === 'object' ? addr.port : config.port

  return {
    port,
    async close() {
      // Detach PTY clients — tmux sessions keep running (Phase 1 contract; never kill the server).
      await ptyManager.killAll()
      // Close the loopback hook-server listener (it would otherwise die with the process anyway).
      hookServer.stop()
      await new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()))
      })
    }
  }
}
