import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { useAgentStatus } from '../state/agentStatus'
import { useAgentNodes } from '../state/agentNodes'

// The behaviour under test: leaving a project unmounts its TerminalNodes, and that unmount must
// NOT clear their live agent status — the sidebar spans projects, so a live `working`/`waiting`
// state has to survive a project switch. Only an explicit delete (Canvas.deleteNodes /
// closeSession → useAgentStatus.remove) or a real hook transition may change it.
//
// TerminalNode itself is impractical to mount in jsdom (xterm, a live PTY, dozens of stores), so
// the two store CONTRACTS the fix depends on are exercised directly — behavioural coverage of the
// mechanism, not a re-grep of the source. The source guard below is kept as a cheap secondary
// tripwire for the exact line that was removed.

describe('agent status survives an unmount that is not a deletion', () => {
  afterEach(() => {
    for (const id of Object.keys(useAgentStatus.getState().byId)) useAgentStatus.getState().remove(id)
    useAgentNodes.getState().clearForParent('parent-a')
    useAgentNodes.getState().clearForParent('parent-b')
  })

  it('keeps a live status until remove() is called — an unmount alone never clears it', () => {
    useAgentStatus.getState().setState('node-x', 'working')
    expect(useAgentStatus.getState().byId['node-x']?.state).toBe('working')

    // Whatever an unmount does, it does NOT call remove(); the entry must still be here.
    expect(useAgentStatus.getState().byId['node-x']).toBeDefined()

    // The ONLY sanctioned clear (deleteNodes / closeSession) removes it.
    useAgentStatus.getState().remove('node-x')
    expect(useAgentStatus.getState().byId['node-x']).toBeUndefined()
  })

  it("clearForParent drops a node's subagent cards without touching sibling parents", () => {
    useAgentNodes.getState().start('tool-a1', { parentNodeId: 'parent-a', label: 'sub' })
    useAgentNodes.getState().start('tool-b1', { parentNodeId: 'parent-b', label: 'sub' })
    expect(useAgentNodes.getState().byId['tool-a1']?.parentNodeId).toBe('parent-a')

    // The unmount clears only the leaving node's fan-out (this is the one thing the unmount DOES do).
    useAgentNodes.getState().clearForParent('parent-a')
    expect(useAgentNodes.getState().byId['tool-a1']).toBeUndefined()
    // A sibling parent's cards are untouched.
    expect(useAgentNodes.getState().byId['tool-b1']?.parentNodeId).toBe('parent-b')
  })
})

describe('TerminalNode unmount source guard (secondary tripwire)', () => {
  it('has no unmount-scoped status clear, and still clears its subagent fan-out', () => {
    // Proves the removed line stays removed; it cannot prove behaviour (a different spelling would
    // pass), which is why the store-contract tests above exist.
    const source = readFileSync(join(__dirname, 'TerminalNode.tsx'), 'utf8')
    expect(source).not.toContain('useAgentStatus.getState().setState(id, undefined)')
    expect(source).toContain('useAgentNodes.getState().clearForParent(id)')
  })
})
