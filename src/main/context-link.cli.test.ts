import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CLI_SCRIPT } from './context-link-core'

let dir: string

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'ctxlink-'))
  writeFileSync(join(dir, 'context-cli.mjs'), CLI_SCRIPT)
  const transcript = [
    JSON.stringify({ type: 'user', message: { content: 'deploy the app' } }),
    JSON.stringify({
      type: 'assistant',
      message: {
        content: [
          { type: 'text', text: 'On it.' },
          { type: 'tool_use', name: 'Bash', input: { command: 'npm run build' } }
        ]
      }
    })
  ].join('\n')
  writeFileSync(join(dir, 'b.jsonl'), transcript)
  writeFileSync(
    join(dir, 'node-A.json'),
    JSON.stringify({
      self: { id: 'node-A' },
      links: [
        { id: 'node-B', title: 'Builder', cwd: '', transcriptPath: join(dir, 'b.jsonl'), tmux: 'nt-node-B' },
        { id: 'note-1', title: 'Deploy notes', cwd: '', transcriptPath: '', tmux: '', note: 'use the staging key' }
      ],
      tmuxBin: null,
      tmuxSocket: 'node-terminal'
    })
  )
})

afterAll(() => rmSync(dir, { recursive: true, force: true }))

function run(nodeId: string, args: string[]): string {
  return execFileSync(process.execPath, [join(dir, 'context-cli.mjs'), ...args], {
    encoding: 'utf-8',
    env: { ...process.env, NODETERM_NODE_ID: nodeId }
  })
}

describe('context-cli', () => {
  it('list shows the linked node', () => {
    const out = run('node-A', ['list'])
    expect(out).toContain('Builder')
    expect(out).toContain('node-B')
  })
  it('summary prints recent conversation lines', () => {
    const out = run('node-A', ['summary', '-n', '10', '--node', 'node-B'])
    expect(out).toContain('deploy the app')
    expect(out).toContain('On it.')
    expect(out).toContain('npm run build')
  })
  it('transcript prints the full conversation', () => {
    const out = run('node-A', ['transcript', '--node', 'node-B'])
    expect(out).toContain('full transcript')
    expect(out).toContain('deploy the app')
  })
  it('terminal mode reports when tmux is unavailable', () => {
    const out = run('node-A', ['terminal', '--node', 'node-B'])
    expect(out).toContain('Terminal capture unavailable')
  })
  it('is a no-op without NODETERM_NODE_ID', () => {
    const out = run('', ['list'])
    expect(out).toContain('Not a nodeterm session')
  })
  it('list marks sticky notes', () => {
    const out = run('node-A', ['list'])
    expect(out).toContain('Deploy notes (note)')
  })
  it('summary of a note prints its text', () => {
    const out = run('node-A', ['summary', '--node', 'note-1'])
    expect(out).toContain('Deploy notes — note')
    expect(out).toContain('use the staging key')
  })
  it('transcript of a note prints its text too', () => {
    const out = run('node-A', ['transcript', '--node', 'Deploy notes'])
    expect(out).toContain('use the staging key')
  })
  it('terminal of a note explains there is no terminal', () => {
    const out = run('node-A', ['terminal', '--node', 'note-1'])
    expect(out).toContain('sticky note')
    expect(out).toContain('no terminal')
  })
})
