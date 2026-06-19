import { describe, expect, it } from 'vitest'
import { buildGitHistoryViewModels, buildDefaultGitHistoryColorMap } from './git-history-graph'
import { dedupeRemoteTrackingRefs } from './git-history-ref-display'
import type { GitHistoryItem, GitHistoryItemRef } from './git-history-types'

const commit = (id: string, parentIds: string[], refs: GitHistoryItemRef[] = []): GitHistoryItem => ({
  id, parentIds, subject: id, message: id, references: refs
})

describe('buildGitHistoryViewModels', () => {
  it('marks the current revision as the HEAD node', () => {
    const items = [commit('aaa', ['bbb']), commit('bbb', [])]
    const currentRef: GitHistoryItemRef = { id: 'refs/heads/main', name: 'main', revision: 'aaa', category: 'branches' }
    const vms = buildGitHistoryViewModels(items, buildDefaultGitHistoryColorMap({ currentRef }), currentRef)
    expect(vms[0]!.kind).toBe('HEAD')
    expect(vms[1]!.kind).toBe('node')
  })

  it('gives a linear chain one output swimlane per non-root commit', () => {
    const items = [commit('aaa', ['bbb']), commit('bbb', [])]
    const vms = buildGitHistoryViewModels(items)
    expect(vms[0]!.outputSwimlanes).toHaveLength(1)
    expect(vms[1]!.outputSwimlanes).toHaveLength(0)
  })
})

describe('dedupeRemoteTrackingRefs', () => {
  it('drops origin/main when local main is present', () => {
    const refs: GitHistoryItemRef[] = [
      { id: 'refs/heads/main', name: 'main', category: 'branches' },
      { id: 'refs/remotes/origin/main', name: 'origin/main', category: 'remote branches' }
    ]
    expect(dedupeRemoteTrackingRefs(refs).map((r) => r.name)).toEqual(['main'])
  })
})
