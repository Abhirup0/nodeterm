import { describe, it, expect } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import net from 'net'
import { startServer } from '../../src/server/index'

// Headless notification-host boot smoke: every core service (incl. the loopback hook server) boots,
// but NO public HTTP/WS listener is bound. Follows the same startServer harness as server-e2e, minus
// tmux/pty (nothing is spawned here), so it runs everywhere.
describe('server headless mode: boots core services, binds no public listener', () => {
  it('startServer with headless:true returns port 0 and closes cleanly', async () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-headless-'))
    try {
      const srv = await startServer({
        port: 8443,
        host: '127.0.0.1',
        dataDir,
        rendererDir: path.join(dataDir, 'no-renderer'),
        insecureHttp: false,
        headless: true,
        // Never touch the developer's real ~/.claude — the hook would point into `dataDir`,
        // which the teardown removes, leaving a dangling hook that breaks agent sessions.
        installHooks: false
      })
      // Nothing bound: the sentinel port is 0.
      expect(srv.port).toBe(0)
      // And the configured port (8443) is NOT listening — a connect attempt is refused.
      const listening = await new Promise<boolean>((resolve) => {
        const sock = net
          .connect({ host: '127.0.0.1', port: 8443 }, () => {
            sock.destroy()
            resolve(true)
          })
          .on('error', () => resolve(false))
        sock.setTimeout(500, () => {
          sock.destroy()
          resolve(false)
        })
      })
      expect(listening).toBe(false)
      await srv.close()
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true })
    }
  }, 30_000)
})
