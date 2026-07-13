import os from 'os'
import { describe, expect, it } from 'vitest'
import {
  controlPathFor,
  masterArgs,
  childArgs,
  remoteTmuxHasSessionArgs,
  remoteCapturePaneArgs,
  remoteTmuxPtyArgs,
  listDirArgs,
  mkDirArgs,
  RMT_TMUX_SOCKET,
  hookForwardArgs,
  hookForwardCancelArgs,
  remoteHookEnvArgs,
  remoteEndpointFileContents,
  scpArgs
} from './control-master'

const conn = { host: 'h.example.com', user: 'deploy', port: 2222, identityFile: '/k/id' }

describe('mkDirArgs', () => {
  it('mkdir -p the quoted remote path, leaving a leading ~ unquoted', () => {
    expect(mkDirArgs(conn, '/s.sock', '~/new dir').join(' ')).toContain(`mkdir -p ~/'new dir'`)
  })
})

describe('controlPathFor', () => {
  it('returns a SHORT, space-free socket path under ~/.nodeterm/ssh-cm (not the long/spaced userData)', () => {
    // Regression: macOS userData is `~/Library/Application Support/<app>` — too long for a unix
    // socket (sun_path 104, minus ssh's ~17-char bind suffix) AND has a space ssh's `-o` rejects.
    const cp = controlPathFor('a-fairly-long-project-id-0123456789')
    expect(cp.startsWith(`${os.homedir()}/.nodeterm/ssh-cm/`)).toBe(true)
    expect(cp.endsWith('.sock')).toBe(true)
    expect(cp).not.toContain(' ')
    // Must stay well under 104 even after ssh appends its ~17-char temp suffix while binding.
    expect(cp.length).toBeLessThan(87)
  })
  it('is deterministic and distinct per project id', () => {
    expect(controlPathFor('proj1')).toBe(controlPathFor('proj1'))
    expect(controlPathFor('proj1')).not.toBe(controlPathFor('proj2'))
  })
})

describe('masterArgs', () => {
  it('builds a backgrounded multiplexing master with the control path + identity + port', () => {
    expect(masterArgs(conn, '/ud/ssh-cm/p.sock')).toEqual([
      '-M', '-N',
      '-o', 'ControlMaster=auto',
      '-o', 'ControlPath=/ud/ssh-cm/p.sock',
      '-o', 'ControlPersist=300',
      '-o', 'BatchMode=no',
      '-p', '2222',
      '-i', '/k/id',
      'deploy@h.example.com'
    ])
  })
})

describe('childArgs', () => {
  it('reuses the master socket (no new master) and appends a remote command', () => {
    expect(childArgs(conn, '/s.sock', 'tmux ls')).toEqual([
      '-o', 'ControlMaster=no',
      '-o', 'ControlPath=/s.sock',
      '-p', '2222',
      'deploy@h.example.com',
      'tmux ls'
    ])
  })
})

describe('remoteTmuxHasSessionArgs', () => {
  it('checks the remote socket for the node session', () => {
    expect(remoteTmuxHasSessionArgs(conn, '/s.sock', 'nt-x')).toEqual([
      '-o', 'ControlMaster=no', '-o', 'ControlPath=/s.sock', '-p', '2222',
      'deploy@h.example.com',
      `tmux -L ${RMT_TMUX_SOCKET} has-session -t nt-x`
    ])
  })
})

describe('remoteCapturePaneArgs', () => {
  it('captures the whole scrollback (-S -) when full', () => {
    const args = remoteCapturePaneArgs(conn, '/s.sock', 'nt-x', true)
    expect(args[args.length - 1]).toBe(`tmux -L ${RMT_TMUX_SOCKET} capture-pane -p -e -t nt-x -S -`)
  })
  it('captures the recent ~200 lines (-S -200) when not full', () => {
    const args = remoteCapturePaneArgs(conn, '/s.sock', 'nt-x', false)
    expect(args[args.length - 1]).toBe(`tmux -L ${RMT_TMUX_SOCKET} capture-pane -p -e -t nt-x -S -200`)
  })
})

describe('remoteTmuxPtyArgs', () => {
  it('runs the remote tmux command as a forced-TTY child (-t then childArgs)', () => {
    const args = remoteTmuxPtyArgs(conn, '/s.sock', 'nt-x', '/srv/app')
    expect(args[0]).toBe('-t')
    const cmd = args[args.length - 1]
    expect(args.slice(1)).toEqual(childArgs(conn, '/s.sock', cmd))
  })
  it('splices extraEnv -e pairs right after new-session -A (before -s)', () => {
    const args = remoteTmuxPtyArgs(conn, '/s.sock', 'nt-x', '/srv/app', undefined, undefined, [
      '-e', 'NODETERM_HOOK_ENDPOINT=/r/ep.env',
      '-e', 'NODETERM_NODE_ID=nt-x'
    ])
    const cmd = args[args.length - 1]
    expect(cmd).toContain('new-session -A -e NODETERM_HOOK_ENDPOINT=/r/ep.env -e NODETERM_NODE_ID=nt-x -s')
  })
  it('threads confPath to remoteTmuxCommand as a `-f` source before new-session', () => {
    const args = remoteTmuxPtyArgs(conn, '/s.sock', 'nt-x', '/srv/app', undefined, undefined, [], '/home/u/.nodeterm/tmux.conf')
    const cmd = args[args.length - 1]
    expect(cmd).toContain(`-f '/home/u/.nodeterm/tmux.conf' new-session -A`)
  })
})

describe('hook forwarding', () => {
  it('hookForwardArgs builds a reverse unix-socket forward over the master', () => {
    expect(hookForwardArgs(conn, '/s.sock', '/home/u/.nodeterm/h.sock', 51234)).toEqual([
      '-O', 'forward', '-R', '/home/u/.nodeterm/h.sock:127.0.0.1:51234',
      '-o', 'ControlPath=/s.sock', '-p', '2222', 'deploy@h.example.com'
    ])
  })
  it('hookForwardCancelArgs mirrors it with -O cancel', () => {
    expect(hookForwardCancelArgs(conn, '/s.sock', '/r.sock', 51234)[1]).toBe('cancel')
  })
  it('remoteHookEnvArgs builds tmux -e pairs (endpoint + node id + version)', () => {
    expect(remoteHookEnvArgs('/r/.nodeterm/ep.env', 'nt-x', '1')).toEqual([
      '-e', 'NODETERM_HOOK_ENDPOINT=/r/.nodeterm/ep.env',
      '-e', 'NODETERM_NODE_ID=nt-x',
      '-e', 'NODETERM_HOOK_VERSION=1'
    ])
  })
  it('emits NODETERM_NODE_ID as the RAW persistKey (not the nt-<id> tmux session name)', () => {
    // Cross-boundary contract: the remote hook env's NODETERM_NODE_ID MUST equal what the
    // LOCAL path's hookServer.buildPtyEnv(persistKey, …) sets — i.e. the RAW React Flow node id.
    // Canvas.tsx onAgentStatus keys agentStatus.byId / selection off that raw id with no `nt-`
    // stripping, so passing the session name (`nt-<id>`) would orphan every remote event.
    const persistKey = 'node-abc'
    const env = remoteHookEnvArgs('/ep', persistKey, '1')
    expect(env).toContain(`NODETERM_NODE_ID=${persistKey}`)
    // Guard against a regression that passes sessionName(persistKey) = `nt-<id>`.
    expect(env).not.toContain(`NODETERM_NODE_ID=nt-${persistKey}`)
  })
  it('remoteEndpointFileContents writes SOCK/TOKEN/VERSION', () => {
    expect(remoteEndpointFileContents('/r.sock', 'tok', '1')).toBe(
      'NODETERM_HOOK_SOCK=/r.sock\nNODETERM_HOOK_TOKEN=tok\nNODETERM_HOOK_VERSION=1\n'
    )
  })
})

describe('scpArgs', () => {
  it('reuses the master socket, uses scp -P for the port, and passes the RAW absolute remote path', () => {
    const j = scpArgs(conn, '/s.sock', '/local/i m.png', '/home/u/.nodeterm/uploads/t/i m.png').join(' ')
    expect(j).toContain('-o ControlPath=/s.sock')
    expect(j).toContain('-o BatchMode=yes')  // fail fast on a fallback connection (no tty prompt)
    expect(j).toContain('-P 2222')          // scp uses uppercase -P
    expect(j).toContain('-i /k/id')          // identityFile
    // Modern scp uses SFTP (no remote shell), so the remote path must be RAW (NOT quoted) — a quoted
    // path makes the SFTP server open a file literally named `'…'`. SFTP handles spaces literally.
    expect(j).toContain(`/local/i m.png deploy@h.example.com:/home/u/.nodeterm/uploads/t/i m.png`)
  })
})

describe('listDirArgs', () => {
  it('lists directory entries of a quoted absolute path', () => {
    expect(listDirArgs(conn, '/s.sock', '/srv/app')).toEqual([
      '-o', 'ControlMaster=no', '-o', 'ControlPath=/s.sock', '-p', '2222',
      'deploy@h.example.com',
      `ls -1Ap '/srv/app'`
    ])
  })
  it('leaves a bare ~ unquoted so the remote shell expands it', () => {
    expect(listDirArgs(conn, '/s.sock', '~')).toEqual([
      '-o', 'ControlMaster=no', '-o', 'ControlPath=/s.sock', '-p', '2222',
      'deploy@h.example.com',
      `ls -1Ap ~`
    ])
  })
  it('tilde-expands a home-relative path, quoting the remainder', () => {
    expect(listDirArgs(conn, '/s.sock', '~/my dir')).toEqual([
      '-o', 'ControlMaster=no', '-o', 'ControlPath=/s.sock', '-p', '2222',
      'deploy@h.example.com',
      `ls -1Ap ~/'my dir'`
    ])
  })
})
