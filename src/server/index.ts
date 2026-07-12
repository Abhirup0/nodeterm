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
import { initAgentStatusMirror } from '../core/agent-status-mirror'
import { presenceHub } from '../core/presence/hub'
import { wireAgentStatus } from './agent-status'
import { IPC } from '@shared/ipc'

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
  // Team presence (hello / cursor / focus / chat). The hub itself is joined per WebSocket in
  // ws.ts; this only registers the RPC surface. Presence is transient — nothing is persisted.
  presenceHub.registerIpc()

  // WS backpressure: when a connection's socket send buffer fills while streaming pty
  // output, pause that tmux client so the OS pipe applies real backpressure (resumes below
  // the low-water mark). See platform-server.ts sendTo.
  platform.setFlowController((sid, resume) => ptyManager.setFlow(sid, resume))

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
  wireAgentStatus(platform)
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
  attachWsServer(server, { platform, auth })

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
