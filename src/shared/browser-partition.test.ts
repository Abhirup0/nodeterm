import { describe, it, expect } from 'vitest'
import { agentBrowserPartition } from './browser-partition'

describe('agentBrowserPartition', () => {
  it('is per-project and prefixed persist:', () => {
    expect(agentBrowserPartition('p-1')).toBe('persist:nt-agent-browser-p-1')
  })
  it('REFUSES an id isSafeNodeId refuses — this becomes a persisted storage key', () => {
    // Project ids come from project.json, which travels in cloned repos. A partition name is not a
    // path segment, but it IS a persisted-storage key, and the class of mistake is identical to
    // docs/node-identity.md §"Ids are path segments".
    for (const bad of ['..', '.', '', 'a/b', 'a b', '../../x', 'x'.repeat(300)]) {
      expect(agentBrowserPartition(bad), bad).toBe(null)
    }
  })
})
