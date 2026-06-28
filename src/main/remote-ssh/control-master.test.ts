import { describe, expect, it } from 'vitest'
import {
  controlPathFor,
  masterArgs,
  childArgs,
  remoteTmuxHasSessionArgs,
  remoteCapturePaneArgs,
  remoteTmuxPtyArgs,
  listDirArgs,
  RMT_TMUX_SOCKET
} from './control-master'

const conn = { host: 'h.example.com', user: 'deploy', port: 2222, identityFile: '/k/id' }

describe('controlPathFor', () => {
  it('puts a per-project socket under <userData>/ssh-cm', () => {
    expect(controlPathFor('/ud', 'proj1')).toBe('/ud/ssh-cm/proj1.sock')
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
