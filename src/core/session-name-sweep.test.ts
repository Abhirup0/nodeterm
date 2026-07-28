import { describe, it, expect, vi } from 'vitest'
import { sweepSessionNames, type SweepEntry } from './session-name-sweep'

function deps(
  entries: SweepEntry[],
  opts: {
    names?: Record<string, string | null>
    nodes?: Record<string, { accountId?: string; titleAuto?: boolean }>
    throwFor?: string
  } = {}
) {
  const published: [string, string][] = []
  const resolve = vi.fn(async (sessionId: string) => {
    if (opts.throwFor === sessionId) throw new Error('transient')
    return opts.names?.[sessionId] ?? null
  })
  return {
    published,
    resolve,
    d: {
      entries: () => entries,
      node: (id: string) => opts.nodes?.[id],
      resolve,
      publish: (nodeId: string, name: string) => published.push([nodeId, name]),
      supports: (agentId?: string) => agentId === 'claude'
    }
  }
}

describe('sweepSessionNames', () => {
  it('publishes a changed name for a node no canvas has mounted', async () => {
    const { d, published } = deps([{ nodeId: 'n1', sessionId: 's1', agentId: 'claude', name: 'old' }], {
      names: { s1: 'mac-release-rerun-notarization' }
    })
    expect(await sweepSessionNames(d)).toBe(1)
    expect(published).toEqual([['n1', 'mac-release-rerun-notarization']])
  })

  it('writes nothing when the name is unchanged or unresolvable', async () => {
    const { d, published } = deps(
      [
        { nodeId: 'same', sessionId: 's1', agentId: 'claude', name: 'Ship it' },
        { nodeId: 'unknown', sessionId: 's2', agentId: 'claude' }
      ],
      { names: { s1: 'Ship it', s2: null } }
    )
    expect(await sweepSessionNames(d)).toBe(0)
    expect(published).toEqual([])
  })

  it('leaves a hand-renamed node alone (titleAuto false)', async () => {
    const { d, published } = deps([{ nodeId: 'n1', sessionId: 's1', agentId: 'claude' }], {
      names: { s1: 'the session name' },
      nodes: { n1: { titleAuto: false } }
    })
    expect(await sweepSessionNames(d)).toBe(0)
    expect(published).toEqual([])
  })

  it('skips agents that have no session name, and nodes with no session', async () => {
    const { d, resolve } = deps([
      { nodeId: 'codex', sessionId: 's1', agentId: 'codex' },
      { nodeId: 'nosession', agentId: 'claude' }
    ])
    expect(await sweepSessionNames(d)).toBe(0)
    expect(resolve).not.toHaveBeenCalled()
  })

  it('passes the node account through — managed accounts scope the transcript root', async () => {
    const { d, resolve } = deps([{ nodeId: 'n1', sessionId: 's1', agentId: 'claude' }], {
      names: { s1: 'x' },
      nodes: { n1: { accountId: 'acct-2' } }
    })
    await sweepSessionNames(d)
    expect(resolve).toHaveBeenCalledWith('s1', 'acct-2')
  })

  it('one failing read never stops the pass', async () => {
    const { d, published } = deps(
      [
        { nodeId: 'bad', sessionId: 'boom', agentId: 'claude' },
        { nodeId: 'good', sessionId: 's2', agentId: 'claude' }
      ],
      { names: { s2: 'still works' }, throwFor: 'boom' }
    )
    expect(await sweepSessionNames(d)).toBe(1)
    expect(published).toEqual([['good', 'still works']])
  })
})
