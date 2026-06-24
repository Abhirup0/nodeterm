import { describe, it, expect } from 'vitest'
import { buildLinkDoc, setNodeTranscript, transcriptPathOf } from './context-link-core'

describe('buildLinkDoc', () => {
  it('enriches each link with tmux name, injected transcript path, and cwd', () => {
    const doc = buildLinkDoc(
      'node-A',
      [
        { id: 'node-B', title: 'Builder', cwd: '/proj' },
        { id: 'node-C', title: 'Tester' }
      ],
      {
        transcriptOf: (id) => (id === 'node-B' ? '/t/b.jsonl' : ''),
        tmuxBin: '/usr/bin/tmux',
        tmuxSocket: 'node-terminal'
      }
    )
    expect(doc.self).toEqual({ id: 'node-A' })
    expect(doc.tmuxBin).toBe('/usr/bin/tmux')
    expect(doc.tmuxSocket).toBe('node-terminal')
    expect(doc.links).toEqual([
      { id: 'node-B', title: 'Builder', cwd: '/proj', transcriptPath: '/t/b.jsonl', tmux: 'nt-node-B' },
      { id: 'node-C', title: 'Tester', cwd: '', transcriptPath: '', tmux: 'nt-node-C' }
    ])
  })

  it('sanitizes the tmux session name like the pty manager', () => {
    const doc = buildLinkDoc('x', [{ id: 'a b/c.d', title: 'T' }], {
      transcriptOf: () => '',
      tmuxBin: null,
      tmuxSocket: 's'
    })
    expect(doc.links[0].tmux).toBe('nt-a_b_c_d')
  })
})

describe('setNodeTranscript / transcriptPathOf', () => {
  it('stores and returns the transcript path by node id', () => {
    setNodeTranscript('n1', 'sess', '/path/one.jsonl')
    expect(transcriptPathOf('n1')).toBe('/path/one.jsonl')
  })
  it('ignores empty node id or path', () => {
    setNodeTranscript('', 's', '/p.jsonl')
    setNodeTranscript('n2', 's', '')
    expect(transcriptPathOf('n2')).toBe('')
  })
  it('returns empty string for an unknown node', () => {
    expect(transcriptPathOf('nope')).toBe('')
  })
})
