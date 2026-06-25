import { describe, expect, it } from 'vitest'
import { buildSshArgs, parseExtraArgs, parseSshConfig } from './ssh'

describe('parseSshConfig', () => {
  it('parses a named host with HostName/User/Port/IdentityFile', () => {
    const cfg = `Host prod
  HostName 10.0.0.5
  User deploy
  Port 2222
  IdentityFile ~/.ssh/prod_ed25519`
    expect(parseSshConfig(cfg)).toEqual([
      { label: 'prod', host: '10.0.0.5', user: 'deploy', port: 2222, identityFile: '~/.ssh/prod_ed25519' }
    ])
  })

  it('falls back to the alias when HostName is absent and leaves optional fields undefined', () => {
    expect(parseSshConfig('Host box\n  User me')).toEqual([
      { label: 'box', host: 'box', user: 'me', port: undefined, identityFile: undefined }
    ])
  })

  it('skips wildcard hosts and the catch-all', () => {
    const cfg = `Host *
  User everyone
Host *.internal
  User x
Host real
  HostName r.example.com`
    expect(parseSshConfig(cfg)).toEqual([
      { label: 'real', host: 'r.example.com', user: undefined, port: undefined, identityFile: undefined }
    ])
  })

  it('accepts key=value form, comments, and multiple aliases on one Host line', () => {
    const cfg = `Host a b  # two aliases
  HostName=h.example.com
  Port=22`
    expect(parseSshConfig(cfg)).toEqual([
      { label: 'a', host: 'h.example.com', user: undefined, port: 22, identityFile: undefined },
      { label: 'b', host: 'h.example.com', user: undefined, port: 22, identityFile: undefined }
    ])
  })
})

describe('buildSshArgs', () => {
  it('minimal host/user', () => {
    expect(buildSshArgs({ host: 'example.com', user: 'alice' })).toEqual([
      '-p',
      '22',
      'alice@example.com'
    ])
  })

  it('custom port + identity file', () => {
    expect(
      buildSshArgs({ host: 'h', user: 'u', port: 2222, identityFile: '/keys/id_ed25519' })
    ).toEqual(['-p', '2222', '-i', '/keys/id_ed25519', 'u@h'])
  })

  it('extra args are tokenized and inserted before the target', () => {
    expect(
      buildSshArgs({ host: 'h', user: 'u', extraArgs: '-A -o ServerAliveInterval=30' })
    ).toEqual(['-p', '22', '-A', '-o', 'ServerAliveInterval=30', 'u@h'])
  })
})

describe('parseExtraArgs', () => {
  it('respects single and double quotes', () => {
    expect(parseExtraArgs(`-o "ProxyCommand=ssh -W %h:%p bastion" -A`)).toEqual([
      '-o',
      'ProxyCommand=ssh -W %h:%p bastion',
      '-A'
    ])
  })

  it('empty/undefined → []', () => {
    expect(parseExtraArgs(undefined)).toEqual([])
    expect(parseExtraArgs('   ')).toEqual([])
  })
})
