import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const SOURCE = readFileSync(join(__dirname, 'TerminalNode.tsx'), 'utf8')

describe('TerminalNode status lifecycle', () => {
  it('does not clear live status when a project switch unmounts the node', () => {
    // The sidebar spans projects, so leaving one canvas is not a session-state transition. Actual
    // deletion owns status removal in Canvas.deleteNodes, and hooks own live state changes.
    expect(SOURCE).not.toContain('useAgentStatus.getState().setState(id, undefined)')
    expect(SOURCE).toContain('useAgentNodes.getState().clearForParent(id)')
  })
})
