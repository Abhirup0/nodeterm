import { describe, it, expect } from 'vitest'
import { agentBrowserPartition, loadedAgentBrowserPartition } from './browser-partition'

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

describe('loadedAgentBrowserPartition — the hostile-load gate', () => {
  it('keeps a partition that is EXACTLY the one this project would mint', () => {
    expect(loadedAgentBrowserPartition('persist:nt-agent-browser-p1', 'p1')).toBe('persist:nt-agent-browser-p1')
  })
  it("drops a FOREIGN project's jar — project.json cannot name persist:...-<victim>", () => {
    // The whole finding: a cloned file shipping another project's jar name must not reach the webview.
    expect(loadedAgentBrowserPartition('persist:nt-agent-browser-victim', 'p1')).toBeUndefined()
  })
  it('drops an unsafe/oddly-shaped storage-key string', () => {
    for (const bad of ['persist:nt-agent-browser-../x', 'evil', 'persist:nt-agent-browser-a b', 'persist:other-p1']) {
      expect(loadedAgentBrowserPartition(bad, 'p1'), bad).toBeUndefined()
    }
  })
  it('a partition-less (user-opened) node stays partition-less', () => {
    expect(loadedAgentBrowserPartition(undefined, 'p1')).toBeUndefined()
  })
  it('an unsafe PROJECT id can never match, so nothing is kept', () => {
    // agentBrowserPartition('..') is null, so no stored string can equal it.
    expect(loadedAgentBrowserPartition('persist:nt-agent-browser-..', '..')).toBeUndefined()
  })
})
