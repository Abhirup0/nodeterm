import { describe, expect, it } from 'vitest'
import { remoteGitArgs, setGitRemoteResolver, resolveGitRemote } from './remote-git'

const conn = { host: 'h', user: 'u' }

describe('remoteGitArgs', () => {
  it('composes `cd <tilde-cwd> && git <quoted args>` as a remote child command', () => {
    const j = remoteGitArgs(conn, '/s.sock', '~/proj', ['commit', '-m', 'hi there']).join(' ')
    expect(j).toContain(`cd ~/'proj' && git 'commit' '-m' 'hi there'`)
  })
  it('quotes args with shell metacharacters', () => {
    const j = remoteGitArgs(conn, '/s.sock', '/r', ['log', '--format=%H;rm -rf /']).join(' ')
    expect(j).toContain(`git 'log' '--format=%H;rm -rf /'`)
  })
})

describe('git remote resolver registry', () => {
  it('resolves via the set fn, undefined when unset/null', () => {
    setGitRemoteResolver(null)
    expect(resolveGitRemote('/r')).toBeUndefined()
    setGitRemoteResolver((cwd) => (cwd === '/r' ? { conn, controlPath: '/s' } : undefined))
    expect(resolveGitRemote('/r')).toEqual({ conn, controlPath: '/s' })
    expect(resolveGitRemote('/other')).toBeUndefined()
    setGitRemoteResolver(null)
  })
})
