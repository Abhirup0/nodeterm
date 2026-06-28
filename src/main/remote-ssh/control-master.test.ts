import { describe, expect, it } from 'vitest'
import {
  controlPathFor,
  masterArgs,
  childArgs,
  remoteTmuxHasSessionArgs,
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

describe('listDirArgs', () => {
  it('lists directory entries of a quoted path', () => {
    expect(listDirArgs(conn, '/s.sock', '/srv/app')).toEqual([
      '-o', 'ControlMaster=no', '-o', 'ControlPath=/s.sock', '-p', '2222',
      'deploy@h.example.com',
      `ls -1Ap '/srv/app'`
    ])
  })
})
