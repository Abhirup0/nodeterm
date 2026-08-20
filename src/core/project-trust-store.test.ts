import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { promises as fs, readFileSync } from 'fs'
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

  // `user@host` alone is not a machine. A jump host, a container, and a VM behind the same DNS name
  // are routinely separated by PORT ONLY (sshAttachmentId already keys on host+user+port for exactly
  // this reason), so an approval granted for the box on :2222 must not silently authorize the box on
  // :22. The trust file is unreleased, so the key gains the port with no migration.
  it('ssh keys are per PORT: the default :22 and an explicit :2222 are different locations', () => {
    const base = { host: 'h', user: 'u' }
    const implicit = sshTrustKey({ server: base, remoteCwd: '/srv/x' })
    const explicit22 = sshTrustKey({ server: { ...base, port: 22 }, remoteCwd: '/srv/x' })
    const alt = sshTrustKey({ server: { ...base, port: 2222 }, remoteCwd: '/srv/x' })
    // An omitted port IS 22 (that is what ssh dials), so the two must be the SAME location.
    expect(implicit).toBe(explicit22)
    expect(alt).not.toBe(implicit)
    expect(implicit).toContain('u@h:22')
    expect(alt).toContain('u@h:2222')
    // Still per-remoteCwd, and still not a local key.
    expect(sshTrustKey({ server: { ...base, port: 2222 }, remoteCwd: '/srv/y' })).not.toBe(alt)
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
  it('getRecord answers the stored approval, or null when there is none', async () => {
    const key = localTrustKey('/proj')
    const hash = hashTrustContent('npm ci')
    const store = new ProjectTrustStore()
    expect(await store.getRecord(key, 'setup')).toBeNull()
    await store.record(key, 'setup', hash, '2026-08-19T00:00:00Z')
    expect(await store.getRecord(key, 'setup')).toEqual({ contentHash: hash, approvedAt: '2026-08-19T00:00:00Z' })
    expect(await store.getRecord(key, 'agents')).toBeNull() // another family is not this one
    expect(await store.getRecord(localTrustKey('/other'), 'setup')).toBeNull()
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
  it('a non-ENOENT read failure fails closed WITHOUT clobbering the file, and heals once readable', async () => {
    const key = localTrustKey('/proj')
    const h = hashTrustContent('x')
    const filePath = path.join(userData, 'project-trust.json')
    // Seed an intact, persisted approval with a fresh store instance (its own uncorrupted cache).
    await new ProjectTrustStore().record(key, 'setup', h, 't1')
    const original = readFileSync(filePath, 'utf-8')

    const store = new ProjectTrustStore() // fresh instance: cache is empty, forces a real read
    const err = Object.assign(new Error('permission denied'), { code: 'EACCES' })
    const spy = vi.spyOn(fs, 'readFile').mockRejectedValue(err)
    try {
      expect(await store.isTrusted(key, 'setup', h)).toBe(false)
      await expect(store.record(key, 'setup', h, 't2')).rejects.toThrow()
      // The failed record() must not have written anything — readFileSync bypasses the mocked
      // promises API, so this reads the real on-disk bytes.
      expect(readFileSync(filePath, 'utf-8')).toBe(original)
    } finally {
      spy.mockRestore()
    }
    // Once the fs is readable again, the original (never-clobbered) approval is still there.
    expect(await store.isTrusted(key, 'setup', h)).toBe(true)
  })
})
