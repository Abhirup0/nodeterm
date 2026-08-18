import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'
import { ProjectTrustStore, localTrustKey, sshTrustKey, hashTrustContent } from './project-trust-store'

let userData: string
beforeEach(async () => {
  userData = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-trust-'))
  initPlatform(fakePlatform({ userDataDir: userData }))
})
afterEach(async () => { resetPlatformForTests(); await fs.rm(userData, { recursive: true, force: true }) })

describe('trust keys', () => {
  it('are location identities, distinct per kind and per folder', () => {
    expect(localTrustKey('/a/b')).not.toBe(localTrustKey('/a/c'))
    const ssh = sshTrustKey({ server: { host: 'h', user: 'u' }, remoteCwd: '/srv/x' })
    expect(ssh).toContain('u@h')
    expect(ssh).not.toBe(localTrustKey('/srv/x'))
  })
})

describe('ProjectTrustStore', () => {
  it('approval round-trips and survives a new store instance (persisted)', async () => {
    const key = localTrustKey('/proj')
    const hash = hashTrustContent('npm ci')
    const store = new ProjectTrustStore()
    expect(await store.isTrusted(key, 'setup', hash)).toBe(false)
    await store.record(key, 'setup', hash, '2026-08-19T00:00:00Z')
    expect(await store.isTrusted(key, 'setup', hash)).toBe(true)
    expect(await new ProjectTrustStore().isTrusted(key, 'setup', hash)).toBe(true)
  })
  it('changed content is NOT trusted; other families are independent', async () => {
    const key = localTrustKey('/proj')
    const store = new ProjectTrustStore()
    await store.record(key, 'setup', hashTrustContent('npm ci'), 't')
    expect(await store.isTrusted(key, 'setup', hashTrustContent('npm ci && evil'))).toBe(false)
    expect(await store.isTrusted(key, 'agents', hashTrustContent('npm ci'))).toBe(false)
  })
  it('revoke drops one family or the whole key', async () => {
    const key = localTrustKey('/proj')
    const h = hashTrustContent('x')
    const store = new ProjectTrustStore()
    await store.record(key, 'setup', h, 't')
    await store.record(key, 'shell', h, 't')
    await store.revoke(key, 'setup')
    expect(await store.isTrusted(key, 'setup', h)).toBe(false)
    expect(await store.isTrusted(key, 'shell', h)).toBe(true)
    await store.revoke(key)
    expect(await store.isTrusted(key, 'shell', h)).toBe(false)
  })
  it('a malformed trust file fails closed (empty store), then heals on next record', async () => {
    await fs.writeFile(path.join(userData, 'project-trust.json'), '{oops', 'utf-8')
    const store = new ProjectTrustStore()
    const key = localTrustKey('/proj')
    expect(await store.isTrusted(key, 'setup', hashTrustContent('x'))).toBe(false)
    await store.record(key, 'setup', hashTrustContent('x'), 't')
    expect(await new ProjectTrustStore().isTrusted(key, 'setup', hashTrustContent('x'))).toBe(true)
  })
})
