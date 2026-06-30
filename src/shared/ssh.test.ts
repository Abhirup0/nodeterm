import { describe, expect, it } from 'vitest'
import {
  buildSshArgs,
  parseExtraArgs,
  parseSshConfig,
  posixQuote,
  quoteRemotePath,
  remoteTmuxCommand,
  remoteTmuxConf,
  parseLsDirs
} from './ssh'

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

describe('posixQuote', () => {
  it('single-quotes and escapes embedded quotes', () => {
    expect(posixQuote(`a b`)).toBe(`'a b'`)
    expect(posixQuote(`it's`)).toBe(`'it'\\''s'`)
  })
})

describe('quoteRemotePath', () => {
  it('leaves a bare ~ unquoted so the remote shell expands it', () => {
    expect(quoteRemotePath('~')).toBe('~')
  })
  it('keeps a leading ~/ unquoted and single-quotes the remainder', () => {
    expect(quoteRemotePath('~/a b')).toBe(`~/'a b'`)
  })
  it('a bare ~/ stays ~/', () => {
    expect(quoteRemotePath('~/')).toBe('~/')
  })
  it('fully quotes an absolute path (byte-identical to posixQuote)', () => {
    expect(quoteRemotePath('/srv/x')).toBe(`'/srv/x'`)
  })
  it('only a leading ~ or ~/ is special — ~weird is fully quoted', () => {
    expect(quoteRemotePath('~weird')).toBe(`'~weird'`)
  })
})

describe('remoteTmuxCommand', () => {
  it('builds attach-or-create on the remote socket with a quoted cwd', () => {
    expect(remoteTmuxCommand({ sessionId: 'nt-x', remoteCwd: '/srv/app' })).toBe(
      `tmux -L nodeterm-rmt new-session -A -s 'nt-x' -c '/srv/app'`
    )
  })
  it('tilde-expands a home-relative cwd (leaves ~/ unquoted)', () => {
    expect(remoteTmuxCommand({ sessionId: 'nt-x', remoteCwd: '~/project' })).toBe(
      `tmux -L nodeterm-rmt new-session -A -s 'nt-x' -c ~/'project'`
    )
  })
  it('appends a quoted program + args when given', () => {
    expect(
      remoteTmuxCommand({ sessionId: 'nt-x', remoteCwd: '/a', program: 'ssh', programArgs: ['-A', 'h'] })
    ).toBe(`tmux -L nodeterm-rmt new-session -A -s 'nt-x' -c '/a' 'ssh' '-A' 'h'`)
  })
})

describe('remoteTmuxConf', () => {
  const c = remoteTmuxConf(50000)
  it('enables mouse + clipboard and uses OSC 52 (no pbcopy)', () => {
    expect(c).toContain('set -g mouse on')
    expect(c).toContain('set -g set-clipboard on')
    expect(c).toContain('copy-pipe-and-cancel')
    expect(c).not.toContain('pbcopy')
  })
  it('advertises the OSC 52 clipboard-set capability via terminal-overrides (Ms)', () => {
    expect(c).toContain('terminal-overrides')
    expect(c).toContain('Ms=')
  })
  it('floors history-limit at 1000', () => {
    expect(remoteTmuxConf(10)).toContain('set -g history-limit 1000')
    expect(remoteTmuxConf(50000)).toContain('set -g history-limit 50000')
  })
})

describe('remoteTmuxCommand confPath', () => {
  it('adds -f <confPath> before new-session when given', () => {
    const cmd = remoteTmuxCommand({ sessionId: 'nt-x', remoteCwd: '~/app', socket: 'nodeterm-rmt', confPath: '/home/u/.nodeterm/tmux.conf' })
    expect(cmd).toContain(`-f '/home/u/.nodeterm/tmux.conf' new-session`)
  })
  it('omits -f when no confPath', () => {
    const cmd = remoteTmuxCommand({ sessionId: 'nt-x', remoteCwd: '~/app', socket: 'nodeterm-rmt' })
    expect(cmd).not.toContain('-f ')
  })
})

describe('parseLsDirs', () => {
  it('keeps only directory entries from `ls -1Ap`, dropping ./ and ../', () => {
    expect(parseLsDirs('./\n../\nsrc/\nREADME.md\n.git/\nbin/\n')).toEqual(['.git', 'bin', 'src'])
  })
})
