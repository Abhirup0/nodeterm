import { describe, it, expect } from 'vitest'
import os from 'os'
import path from 'path'
import { resolveConfig } from './config'

describe('resolveConfig', () => {
  it('has safe defaults', () => {
    const c = resolveConfig({}, [])
    expect(c.port).toBe(8443)
    expect(c.host).toBe('127.0.0.1')
    expect(c.dataDir).toBe(path.join(os.homedir(), '.nodeterm-server'))
    expect(c.insecureHttp).toBe(false)
  })
  it('env overrides defaults; argv overrides env', () => {
    const c = resolveConfig(
      { NODETERM_PORT: '9000', NODETERM_DATA_DIR: '/data', NODETERM_SERVER_PASSWORD: 'p' },
      ['--port', '9100', '--insecure-http']
    )
    expect(c.port).toBe(9100)
    expect(c.dataDir).toBe('/data')
    expect(c.passwordSeed).toBe('p')
    expect(c.insecureHttp).toBe(true)
  })
  it('refuses a non-loopback bind without --insecure-http', () => {
    expect(() => resolveConfig({ NODETERM_HOST: '0.0.0.0' }, [])).toThrow(/insecure-http|reverse proxy/i)
    expect(() => resolveConfig({ NODETERM_HOST: '0.0.0.0' }, ['--insecure-http'])).not.toThrow()
  })
})
