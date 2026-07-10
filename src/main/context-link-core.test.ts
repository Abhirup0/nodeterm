import { describe, it, expect } from 'vitest'
import {
  buildLinkDoc,
  buildLinkedContextInstructions,
  mergeInstructionsBlock,
  resolveLinkTranscript,
  setNodeTranscript,
  transcriptPathOf
} from './context-link-core'

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

  it('carries a sticky note through with empty transcript/tmux', () => {
    const doc = buildLinkDoc('node-A', [{ id: 'note-1', title: 'Deploy notes', note: 'use staging' }], {
      transcriptOf: () => '/should/not/be/used.jsonl',
      tmuxBin: '/usr/bin/tmux',
      tmuxSocket: 'node-terminal'
    })
    expect(doc.links).toEqual([
      { id: 'note-1', title: 'Deploy notes', cwd: '', transcriptPath: '', tmux: '', note: 'use staging' }
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

describe('buildLinkDoc agent field', () => {
  it('copies agentId onto the entry; notes get none', () => {
    const doc = buildLinkDoc(
      'node-A',
      [
        { id: 'node-B', title: 'B', cwd: '', agentId: 'codex' },
        { id: 'note-1', title: 'N', note: 'txt' }
      ],
      { transcriptOf: () => '', tmuxBin: null, tmuxSocket: 's' }
    )
    expect(doc.links[0].agent).toBe('codex')
    expect(doc.links[1].agent).toBeUndefined()
  })
})

describe('resolveLinkTranscript', () => {
  const locators = {
    claude: async (sid: string, acct?: string) => `/c/${acct ?? 'default'}/${sid}.jsonl`,
    codex: async (sid: string) => `/x/${sid}.jsonl`,
    gemini: async (sid: string) => `/g/${sid}.jsonl`
  }
  it('claude prefers the hook-fed path', async () => {
    const p = await resolveLinkTranscript(
      { id: 'n1', title: 'T', agentId: 'claude', sessionId: 's1' },
      { hooked: () => '/hooked.jsonl', locators }
    )
    expect(p).toBe('/hooked.jsonl')
  })
  it('claude falls back to the locator with accountId when hooks have nothing', async () => {
    const p = await resolveLinkTranscript(
      { id: 'n1', title: 'T', agentId: 'claude', sessionId: 's1', accountId: 'a1' },
      { hooked: () => '', locators }
    )
    expect(p).toBe('/c/a1/s1.jsonl')
  })
  it('a legacy entry without agentId behaves like claude', async () => {
    const p = await resolveLinkTranscript(
      { id: 'n1', title: 'T' },
      { hooked: () => '/hooked.jsonl', locators }
    )
    expect(p).toBe('/hooked.jsonl')
  })
  it('codex and gemini resolve via their locator by sessionId', async () => {
    expect(
      await resolveLinkTranscript({ id: 'n', title: 'T', agentId: 'codex', sessionId: 's2' }, { hooked: () => '/hooked', locators })
    ).toBe('/x/s2.jsonl')
    expect(
      await resolveLinkTranscript({ id: 'n', title: 'T', agentId: 'gemini', sessionId: 's3' }, { hooked: () => '/hooked', locators })
    ).toBe('/g/s3.jsonl')
  })
  it('resolves empty on: note entries, missing sessionId, unknown agent, locator throw', async () => {
    const base = { hooked: () => '', locators }
    expect(await resolveLinkTranscript({ id: 'n', title: 'T', note: 'x' }, base)).toBe('')
    expect(await resolveLinkTranscript({ id: 'n', title: 'T', agentId: 'codex' }, base)).toBe('')
    expect(await resolveLinkTranscript({ id: 'n', title: 'T', agentId: 'custom:x', sessionId: 's' }, base)).toBe('')
    expect(
      await resolveLinkTranscript(
        { id: 'n', title: 'T', agentId: 'codex', sessionId: 's' },
        { hooked: () => '', locators: { codex: async () => { throw new Error('boom') } } }
      )
    ).toBe('')
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

describe('mergeInstructionsBlock', () => {
  const block = 'Use the CLI: sh "/x/context.sh" list'
  it('appends the marker-delimited block to existing content', () => {
    const out = mergeInstructionsBlock('# My rules\n\nBe nice.\n', block)
    expect(out).toContain('# My rules')
    expect(out).toContain('<!-- nodeterm:get-linked-context:start -->')
    expect(out).toContain(block)
    expect(out).toContain('<!-- nodeterm:get-linked-context:end -->')
  })
  it('is idempotent: re-merging replaces the block in place', () => {
    const once = mergeInstructionsBlock('# My rules\n', block)
    const twice = mergeInstructionsBlock(once, 'UPDATED body')
    expect(twice.match(/nodeterm:get-linked-context:start/g)).toHaveLength(1)
    expect(twice).toContain('UPDATED body')
    expect(twice).not.toContain('sh "/x/context.sh" list')
    expect(twice).toContain('# My rules')
  })
  it('works on an empty file', () => {
    const out = mergeInstructionsBlock('', block)
    expect(out.startsWith('<!-- nodeterm:get-linked-context:start -->')).toBe(true)
  })
})

describe('buildLinkedContextInstructions', () => {
  it('embeds the shim path and the four commands', () => {
    const s = buildLinkedContextInstructions('/x/context.sh')
    expect(s).toContain('sh "/x/context.sh" list')
    expect(s).toContain('summary')
    expect(s).toContain('transcript')
    expect(s).toContain('terminal')
  })
})
