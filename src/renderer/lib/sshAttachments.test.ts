import { describe, expect, it } from 'vitest'
import { sshAttachmentId, type SshConnection } from '@shared/ssh'
import { hostAttachmentsFor, type AttachableNode } from './sshAttachments'

const DEVBOX: SshConnection = { host: 'devbox', user: 'corvin', port: 2222 }
const OTHER: SshConnection = { host: 'other', user: 'corvin' }

const remote = (id: string, ssh: SshConnection, cwd?: string): AttachableNode => ({
  id,
  ssh,
  sshRemoteTmux: true,
  cwd
})

describe('hostAttachmentsFor', () => {
  it('attaches every remote node of a LOCAL project to its host', () => {
    const found = hostAttachmentsFor('local-1', [remote('n1', DEVBOX, '/srv/app')])
    expect(found).toHaveLength(1)
    expect(found[0].scopeId).toBe(sshAttachmentId('local-1', DEVBOX))
    expect(found[0].hostKey).toBe('corvin@devbox')
    expect(found[0].remoteCwd).toBe('/srv/app')
    expect(found[0].nodeIds).toEqual(['n1'])
  })

  it('leaves an SSH project alone: its own master already serves its nodes', () => {
    expect(hostAttachmentsFor('ssh-1', [remote('n1', DEVBOX)], DEVBOX)).toEqual([])
  })

  it('attaches a node inside an SSH project that points at a DIFFERENT machine', () => {
    const found = hostAttachmentsFor('ssh-1', [remote('n1', DEVBOX), remote('n2', OTHER)], DEVBOX)
    expect(found.map((a) => a.hostKey)).toEqual(['corvin@other'])
  })

  it('opens ONE master per machine, however many nodes are on it', () => {
    const found = hostAttachmentsFor('local-1', [
      remote('n1', DEVBOX, '/srv/app'),
      remote('n2', { ...DEVBOX }, '/srv/other'),
      remote('n3', OTHER)
    ])
    expect(found).toHaveLength(2)
    const devbox = found.find((a) => a.hostKey === 'corvin@devbox')!
    expect(devbox.nodeIds).toEqual(['n1', 'n2'])
    // The connection is opened at the FIRST node's cwd; each node still spawns in its own.
    expect(devbox.remoteCwd).toBe('/srv/app')
  })

  it('ignores a plain `ssh <host>` node — it runs ssh as its own local pty, no master needed', () => {
    const local: AttachableNode = { id: 'n1', ssh: DEVBOX, sshRemoteTmux: false }
    expect(hostAttachmentsFor('local-1', [local])).toEqual([])
  })

  it('ignores nodes with no ssh binding at all', () => {
    expect(hostAttachmentsFor('local-1', [{ id: 'n1', cwd: '/home/me' }])).toEqual([])
  })

  it('gives two projects on the same machine their own scope', () => {
    const a = hostAttachmentsFor('local-1', [remote('n1', DEVBOX)])[0]
    const b = hostAttachmentsFor('local-2', [remote('n1', DEVBOX)])[0]
    expect(a.scopeId).not.toBe(b.scopeId)
  })

  it('never returns the project id as a scope (that master is not this node’s)', () => {
    for (const scope of hostAttachmentsFor('local-1', [remote('n1', DEVBOX), remote('n2', OTHER)])) {
      expect(scope.scopeId).not.toBe('local-1')
    }
  })
})
