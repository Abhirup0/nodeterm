import { describe, it, expect } from 'vitest'
import { projectSectionId, parseProjectSectionId } from './project-settings-targets'

describe('project section ids', () => {
  it('round-trips and rejects non-project ids', () => {
    expect(parseProjectSectionId(projectSectionId('abc-123'))).toBe('abc-123')
    expect(parseProjectSectionId('terminal')).toBeNull()
    expect(parseProjectSectionId('project-')).toBeNull()
  })
})
