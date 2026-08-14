import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { hookServer } from './hook-server'
import { loadOrCreateNodeAuthSecret, resetNodeAuthSecretForTests } from './node-auth-secret'
import { nodeTokenDir, resetNodeTokenFilesForTests } from './node-token-files'
import { initNodeTokens, ensureNodeToken, sweepNodeToken } from './node-token-service'

let dir = ''
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-svc-'))
  resetPlatformForTests()
  resetNodeAuthSecretForTests()
  resetNodeTokenFilesForTests()
  hookServer.clearNodeAuthSecretForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
})
afterEach(() => {
  hookServer.clearNodeAuthSecretForTests()
  fs.rmSync(dir, { recursive: true, force: true })
})

const canvases = [
  { nodes: [{ id: 'node-1' }, { id: 'node-2' }] },
  { nodes: [{ id: 'node-3' }] }
]

describe('node token service', () => {
  it('materialises every node id in every persisted canvas at boot', async () => {
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    initNodeTokens({ canvases: () => canvases })
    expect(fs.readdirSync(nodeTokenDir()).sort()).toEqual(['node-1', 'node-2', 'node-3'])
  })

  it('writes nothing at all when the server has no secret (legacy mode)', () => {
    hookServer.clearNodeAuthSecretForTests()
    initNodeTokens({ canvases: () => canvases })
    expect(fs.existsSync(nodeTokenDir())).toBe(false)
  })

  it('skips an unsafe id in a corrupt project file without aborting the sweep', async () => {
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    initNodeTokens({ canvases: () => [{ nodes: [{ id: '..' }, { id: 'node-9' }] }] })
    expect(fs.readdirSync(nodeTokenDir())).toEqual(['node-9'])
  })

  it('re-derives identical bytes on a refresh (no churn)', async () => {
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    ensureNodeToken('node-1')
    const first = fs.readFileSync(path.join(nodeTokenDir(), 'node-1'), 'utf8')
    ensureNodeToken('node-1')
    expect(fs.readFileSync(path.join(nodeTokenDir(), 'node-1'), 'utf8')).toBe(first)
  })

  it('sweeps a token on delete', async () => {
    hookServer.setNodeAuthSecret(await loadOrCreateNodeAuthSecret())
    ensureNodeToken('node-1')
    sweepNodeToken('node-1')
    expect(fs.existsSync(path.join(nodeTokenDir(), 'node-1'))).toBe(false)
  })
})
