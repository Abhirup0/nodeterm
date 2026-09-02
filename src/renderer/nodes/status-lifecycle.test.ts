import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { useAgentStatus } from '../state/agentStatus'
import { useAgentNodes } from '../state/agentNodes'

// The behaviour under test: leaving a project unmounts its TerminalNodes, and that unmount must
// NOT clear their live agent status — the sidebar spans projects, so a live `working`/`waiting`
// state has to survive a project switch. Since issue #402 the same rule covers the subagent
// fan-out: an unmount says the component went away, not that the work did, and a still-running
// subagent's card cleared on unmount could never come back (`start` only fires from live hook
// events, and a subagent already past its PreToolUse emits no second one). Clearing is owned by
// the lifecycle events (new turn / session end in Canvas's status listener) and by the explicit
// permanent-removal paths (deleteNodes / cross-project closeSession / deleteProject).
//
// TerminalNode itself is impractical to mount in jsdom (xterm, a live PTY, dozens of stores), so
// the store CONTRACTS the fix depends on are exercised directly — behavioural coverage of the
// mechanism, not a re-grep of the source. The source guards below are kept as cheap secondary
// tripwires for the exact lines that were removed, and for the deletion paths that now owe the
// clear the unmount no longer performs.

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

  it('a running subagent card outlives its parent — only clearForParent drops it, per parent', () => {
    useAgentNodes.getState().start('tool-a1', { parentNodeId: 'parent-a', label: 'sub' })
    useAgentNodes.getState().start('tool-b1', { parentNodeId: 'parent-b', label: 'sub' })
    expect(useAgentNodes.getState().byId['tool-a1']?.parentNodeId).toBe('parent-a')

    // A project switch (unmount) calls nothing on this store, so the card is still here — this is
    // what lets it reappear on switch-back while the subagent is mid-run (issue #402).
    expect(useAgentNodes.getState().byId['tool-a1']?.state).toBe('working')

    // The sanctioned clear (new turn / session end / permanent deletion) drops only that parent's
    // fan-out; a sibling parent's cards are untouched.
    useAgentNodes.getState().clearForParent('parent-a')
    expect(useAgentNodes.getState().byId['tool-a1']).toBeUndefined()
    expect(useAgentNodes.getState().byId['tool-b1']?.parentNodeId).toBe('parent-b')
  })

  it('finish() lands on a card kept across an unmount, so the background end is not lost', () => {
    // The synthetic subagent-end (the <task-notification> sniffed by the context tails) arrives
    // through Canvas's always-mounted listener even while the parent's project is inactive. With
    // the entry kept, that finish must mark the card done rather than no-op on a missing id.
    useAgentNodes.getState().start('tool-a1', { parentNodeId: 'parent-a', label: 'sub' })
    useAgentNodes.getState().finish('tool-a1', { tokens: 105_200 })
    expect(useAgentNodes.getState().byId['tool-a1']?.state).toBe('done')
    expect(useAgentNodes.getState().byId['tool-a1']?.tokens).toBe(105_200)
  })
})

describe('TerminalNode unmount source guard (secondary tripwire)', () => {
  it('has no unmount-scoped status or fan-out clear', () => {
    // Proves the removed lines stay removed; it cannot prove behaviour (a different spelling would
    // pass), which is why the store-contract tests above exist.
    const source = readFileSync(join(__dirname, 'TerminalNode.tsx'), 'utf8')
    expect(source).not.toContain('useAgentStatus.getState().setState(id, undefined)')
    expect(source).not.toContain('useAgentNodes.getState().clearForParent(id)')
  })

  it('the permanent-removal paths in Canvas clear the fan-out the unmount no longer does', () => {
    // deleteNodes, the cross-project closeSession branch, the orphan-session kill and
    // deleteProject each owe an explicit clearForParent now — four call sites beyond the two
    // lifecycle ones (newTurn / sessionPhase end) in the status listener.
    const source = readFileSync(join(__dirname, '..', 'canvas', 'Canvas.tsx'), 'utf8')
    const calls = source.match(/useAgentNodes\.getState\(\)\.clearForParent\(/g) ?? []
    expect(calls.length).toBeGreaterThanOrEqual(4)
  })
})
