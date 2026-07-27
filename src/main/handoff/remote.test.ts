import { describe, it, expect, vi } from 'vitest'
import os from 'os'
import path from 'path'
import { promises as fs } from 'fs'
import { buildHandoff, type HandoffRemote } from './index'

const SESSION = '11111111-2222-3333-4444-555555555555'
const NODE = 'term-remote-1'
const TRANSCRIPT = '/home/deploy/.claude/projects/-srv-app/' + SESSION + '.jsonl'

/** Two claude transcript lines — enough for the renderer to produce a real body. */
const RAW = [
  JSON.stringify({ type: 'user', message: { role: 'user', content: 'ship the parser' } }),
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text: 'on it' }] } })
].join('\n')

function remoteDeps(over: Partial<HandoffRemote> = {}): {
  deps: HandoffRemote
  writes: Array<{ path: string; content: string }>
} {
  const writes: Array<{ path: string; content: string }> = []
  const deps: HandoffRemote = {
    isRemoteNode: () => true,
    hookedTranscriptPath: () => TRANSCRIPT,
    readRemoteFile: async () => RAW,
    writeRemoteFile: async (_n, p, content) => {
      writes.push({ path: p, content })
      return true
    },
    ...over
  }
  return { deps, writes }
}

describe('buildHandoff — remote (SSH project) source', () => {
  it('reads the hook-fed transcript and writes the handoff ON THE HOST, never locally', async () => {
    const { deps, writes } = remoteDeps()
    const mkdir = vi.spyOn(fs, 'mkdir')
    const writeFile = vi.spyOn(fs, 'writeFile')
    const res = await buildHandoff({
      sessionId: SESSION,
      agentId: 'claude',
      sourceNodeId: NODE,
      cwd: '/srv/app',
      remote: deps
    })
    expect('filePath' in res).toBe(true)
    // The returned path is the REMOTE one the transferred-to node will read.
    expect((res as { filePath: string }).filePath).toMatch(/^\/srv\/app\/\.nodeterm\/handoff-term-remote-1-.*\.md$/)
    expect(writes).toHaveLength(1)
    expect(writes[0].content).toContain('ship the parser')
    expect(writes[0].content).toContain('on it')
    // Nothing touched this machine's disk.
    expect(mkdir).not.toHaveBeenCalled()
    expect(writeFile).not.toHaveBeenCalled()
    mkdir.mockRestore()
    writeFile.mockRestore()
  })

  it('never falls back to the LOCAL locators for a remote node', async () => {
    // No hook-fed path yet. A local locator could resolve some unrelated same-id file on this
    // machine; the remote branch must refuse instead of reading a stranger's transcript.
    const { deps, writes } = remoteDeps({ hookedTranscriptPath: () => '' })
    const read = vi.fn()
    const res = await buildHandoff({
      sessionId: SESSION,
      agentId: 'claude',
      sourceNodeId: NODE,
      cwd: '/srv/app',
      remote: { ...deps, readRemoteFile: read }
    })
    expect(res).toEqual({
      error: expect.stringContaining("hooks haven't reported one")
    })
    expect(read).not.toHaveBeenCalled()
    expect(writes).toHaveLength(0)
  })

  it('reports a failed remote read instead of writing an empty handoff', async () => {
    const { deps, writes } = remoteDeps({ readRemoteFile: async () => null })
    const res = await buildHandoff({
      sessionId: SESSION,
      agentId: 'claude',
      sourceNodeId: NODE,
      cwd: '/srv/app',
      remote: deps
    })
    expect(res).toEqual({ error: expect.stringContaining('remote host') })
    expect(writes).toHaveLength(0)
  })

  it('reports a failed remote write rather than returning a path that does not exist', async () => {
    const { deps } = remoteDeps({ writeRemoteFile: async () => false })
    const res = await buildHandoff({
      sessionId: SESSION,
      agentId: 'claude',
      sourceNodeId: NODE,
      cwd: '/srv/app',
      remote: deps
    })
    expect(res).toEqual({ error: expect.stringContaining('Failed to write') })
  })

  it('falls back to the remote home (~), not this machine, when the node has no cwd', async () => {
    const { deps, writes } = remoteDeps()
    const res = await buildHandoff({ sessionId: SESSION, agentId: 'claude', sourceNodeId: NODE, remote: deps })
    expect((res as { filePath: string }).filePath.startsWith('~/.nodeterm/')).toBe(true)
    expect(writes[0].path.startsWith(os.homedir())).toBe(false)
  })

  it('a LOCAL node with remote deps present still takes the local path', async () => {
    // isRemoteNode false ⇒ the deps must be inert (Server Edition / plain local project).
    const { deps, writes } = remoteDeps({ isRemoteNode: () => false })
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'handoff-local-'))
    const res = await buildHandoff({
      sessionId: SESSION,
      agentId: 'claude',
      sourceNodeId: NODE,
      cwd: dir,
      remote: deps
    })
    // No transcript exists locally for this id, so it fails the LOCAL way — the point is that it
    // never consulted the remote deps.
    expect(res).toEqual({ error: "Couldn't find the source conversation transcript." })
    expect(writes).toHaveLength(0)
    await fs.rm(dir, { recursive: true, force: true })
  })
})
