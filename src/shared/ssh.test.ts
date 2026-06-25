import { describe, expect, it } from 'vitest'
import { buildSshArgs, parseExtraArgs } from './ssh'

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
