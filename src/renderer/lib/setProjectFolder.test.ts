import { describe, it, expect } from 'vitest'
import { planSetProjectFolder, folderOccupiedNotice, folderUnreadableNotice } from './setProjectFolder'

const p = (id: string, cwd?: string, closed?: boolean) => ({ id, cwd, closed })

describe('planSetProjectFolder', () => {
  it('binds a folder that holds no project file', () => {
    expect(planSetProjectFolder('/repo', 'p1', [p('p1')], 'absent')).toEqual({ kind: 'bind' })
  })

  it('REFUSES a folder that already holds a canvas — the overwrite this module exists to stop', () => {
    expect(planSetProjectFolder('/repo', 'p1', [p('p1')], 'present')).toEqual({
      kind: 'occupied',
      reason: folderOccupiedNotice('/repo')
    })
  })

  it('refuses an unreadable project file too: a failed read is not evidence of absence (#385)', () => {
    expect(planSetProjectFolder('/repo', 'p1', [p('p1')], 'unreadable')).toEqual({
      kind: 'occupied',
      reason: folderUnreadableNotice('/repo')
    })
  })

  it('routes to the project that already owns the folder instead of minting a second entry', () => {
    const plan = planSetProjectFolder('/repo', 'p1', [p('p1'), p('p2', '/repo')], 'present')
    expect(plan).toEqual({ kind: 'switch', projectId: 'p2', reopen: false })
  })

  it('asks for a REOPEN when the owner is closed — switching would land on an invisible tab', () => {
    const plan = planSetProjectFolder('/repo', 'p1', [p('p1'), p('p2', '/repo', true)], 'absent')
    expect(plan).toEqual({ kind: 'switch', projectId: 'p2', reopen: true })
  })

  it('does not treat the project being pointed at its OWN folder as a foreign owner', () => {
    expect(planSetProjectFolder('/repo', 'p1', [p('p1', '/repo')], 'present')).toEqual({
      kind: 'occupied',
      reason: folderOccupiedNotice('/repo')
    })
  })

  it('prefers the existing owner over the occupied refusal — the file is that project’s own', () => {
    const plan = planSetProjectFolder('/repo', 'p1', [p('p2', '/repo')], 'present')
    expect(plan.kind).toBe('switch')
  })

  it('names the folder in both refusals, so the message is actionable', () => {
    expect(folderOccupiedNotice('/a/b')).toContain('/a/b')
    expect(folderUnreadableNotice('/a/b')).toContain('/a/b')
  })
})
