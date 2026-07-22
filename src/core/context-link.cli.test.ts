// The context-link read path, end to end: the REAL POSIX-sh shim, run by the real /bin/sh,
// against the real hook server and the real renderer. This replaces an identical suite that
// exercised the retired Node CLI — same fixtures and same expectations, so the rewrite answers
// for the behavior it inherited, plus the remote (SSH) case the old shape could not express.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import { mkdtempSync, writeFileSync, rmSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CONTEXT_SHIM_SCRIPT, type LinkDoc } from './context-link-core'
import { renderContextLink, type ContextLinkFetch, type ContextLinkVerb } from './context-link-render'
import { hookServer } from './agents/hook-server'
import { initPlatform, resetPlatformForTests } from './platform'
import { fakePlatform } from './platform-fake'

const run = promisify(execFile)

let dir = ''
let shim = ''
let doc: LinkDoc

/** What the fetchers were asked for — how the remote-routing assertions see the difference. */
const asked: { transcripts: string[]; terminals: string[]; exports: string[] } = {
  transcripts: [],
  terminals: [],
  exports: []
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'ctxlink-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  shim = join(dir, 'context.sh')
  writeFileSync(shim, CONTEXT_SHIM_SCRIPT, { mode: 0o755 })
  chmodSync(shim, 0o755)

  const claudeTranscript = [
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
  const codexTranscript = [
    JSON.stringify({ type: 'session_meta', payload: { id: 'sess-x' } }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'fix the tests' }] }
    }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'Sure, running them.' }] }
    }),
    JSON.stringify({
      type: 'response_item',
      payload: { type: 'function_call', name: 'shell', arguments: '{"command":["npm","test"]}' }
    }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call_output', output: '2 passed' } })
  ].join('\n')
  const geminiTranscript = [
    JSON.stringify({ sessionId: 'g-sess', projectHash: 'abc' }),
    JSON.stringify({ $set: { messages: [{ type: 'user', content: 'hello gemini' }] } }),
    JSON.stringify({ $push: { messages: { type: 'gemini', content: 'hello back' } } })
  ].join('\n')
  const opencodeExport = JSON.stringify({
    messages: [
      { role: 'user', parts: [{ type: 'text', text: 'add rerank' }] },
      {
        role: 'assistant',
        parts: [
          { type: 'text', text: 'done, added rerank.ts' },
          { type: 'tool', tool: 'bash', state: { input: { command: 'npm test' } } }
        ]
      }
    ]
  })

  const bodies: Record<string, string> = {
    'node-B': claudeTranscript,
    'node-X': codexTranscript,
    'node-G': geminiTranscript,
    // A REMOTE node: this fixture stands in for bytes fetched over the ControlMaster.
    'node-R': claudeTranscript
  }

  doc = {
    self: { id: 'node-A' },
    links: [
      { id: 'node-B', title: 'Builder', cwd: '', transcriptPath: join(dir, 'b.jsonl'), tmux: 'nt-node-B' },
      { id: 'node-X', title: 'Coder', cwd: '', transcriptPath: join(dir, 'codex.jsonl'), tmux: 'nt-node-X', agent: 'codex' },
      { id: 'node-G', title: 'Gem', cwd: '', transcriptPath: join(dir, 'gemini.jsonl'), tmux: 'nt-node-G', agent: 'gemini' },
      { id: 'node-Y', title: 'ColdCoder', cwd: '/nowhere', transcriptPath: '', tmux: 'nt-node-Y', agent: 'codex' },
      { id: 'node-O', title: 'OpenCoder', cwd: '', transcriptPath: '', tmux: 'nt-node-O', agent: 'opencode', sessionId: 'ses_abc' },
      { id: 'node-O2', title: 'NoSession', cwd: '', transcriptPath: '', tmux: 'nt-node-O2', agent: 'opencode' },
      { id: 'node-R', title: 'RemoteBuilder', cwd: '', transcriptPath: '/home/u/.claude/projects/x/r.jsonl', tmux: 'nt-node-R' },
      { id: 'note-1', title: 'Deploy notes', cwd: '', transcriptPath: '', tmux: '', note: 'use the staging key' }
    ],
    tmuxBin: null,
    tmuxSocket: 'node-terminal'
  }

  // Fetchers standing in for the real ones (local fs / ssh / tmux): what is under test here is
  // the shim ⇄ route ⇄ renderer path, not the filesystem.
  const fetchers: ContextLinkFetch = {
    transcript: async (node) => {
      asked.transcripts.push(node.id)
      return bodies[node.id] ?? null
    },
    terminal: async (node) => {
      asked.terminals.push(node.id)
      return node.id === 'node-B' ? 'last build ok\n' : ''
    },
    opencodeExport: async (node) => {
      asked.exports.push(node.id)
      return node.id === 'node-O' ? opencodeExport : null
    }
  }

  await hookServer.start()
  hookServer.setContextLinkHandler(async (req) => {
    // Mirrors handleContextLinkRequest's authorization: the document is chosen by the REQUESTER's
    // id, never by anything in the request body.
    if (req.nodeId !== 'node-A') {
      return 'No linked nodes. Draw a context-link edge from this node to another on the canvas.'
    }
    return renderContextLink(doc, req.verb as ContextLinkVerb, req.args, fetchers)
  })
})

afterAll(() => {
  hookServer.stop()
  rmSync(dir, { recursive: true, force: true })
})

async function shimRun(nodeId: string, args: string[]): Promise<string> {
  const { stdout } = await run('/bin/sh', [shim, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      NODETERM_NODE_ID: nodeId,
      NODETERM_HOOK_PORT: String(hookServer.getPort()),
      NODETERM_HOOK_TOKEN: hookServer.getToken()
    },
    maxBuffer: 10 * 1024 * 1024
  })
  return stdout
}

describe('context-link CLI', () => {
  it('list shows the linked node', async () => {
    const out = await shimRun('node-A', ['list'])
    expect(out).toContain('Builder')
    expect(out).toContain('node-B')
  })
  it('summary prints recent conversation lines', async () => {
    const out = await shimRun('node-A', ['summary', '-n', '10', '--node', 'node-B'])
    expect(out).toContain('deploy the app')
    expect(out).toContain('On it.')
    expect(out).toContain('npm run build')
  })
  it('transcript prints the full conversation', async () => {
    const out = await shimRun('node-A', ['transcript', '--node', 'node-B'])
    expect(out).toContain('full transcript')
    expect(out).toContain('deploy the app')
  })
  it('terminal prints the captured pane', async () => {
    const out = await shimRun('node-A', ['terminal', '--node', 'node-B'])
    expect(out).toContain('Builder — terminal')
    expect(out).toContain('last build ok')
  })
  it('terminal reports a session that is not running', async () => {
    const out = await shimRun('node-A', ['terminal', '--node', 'node-X'])
    expect(out).toContain('not running')
  })
  it('is a no-op without NODETERM_NODE_ID', async () => {
    const out = await shimRun('', ['list'])
    expect(out).toContain('Not a nodeterm session')
  })
  it('list marks sticky notes', async () => {
    const out = await shimRun('node-A', ['list'])
    expect(out).toContain('Deploy notes (note)')
  })
  it('summary of a note prints its text', async () => {
    const out = await shimRun('node-A', ['summary', '--node', 'note-1'])
    expect(out).toContain('Deploy notes — note')
    expect(out).toContain('use the staging key')
  })
  it('transcript of a note prints its text too', async () => {
    const out = await shimRun('node-A', ['transcript', '--node', 'Deploy notes'])
    expect(out).toContain('use the staging key')
  })
  it('terminal of a note explains there is no terminal', async () => {
    const out = await shimRun('node-A', ['terminal', '--node', 'note-1'])
    expect(out).toContain('sticky note')
    expect(out).toContain('no terminal')
  })
  it('renders a codex rollout transcript', async () => {
    const out = await shimRun('node-A', ['summary', '-n', '20', '--node', 'node-X'])
    expect(out).toContain('user: fix the tests')
    expect(out).toContain('assistant: Sure, running them.')
    expect(out).toContain('$ shell')
    expect(out).toContain('= 2 passed')
  })
  it('renders a gemini chat transcript (event-sourced replay)', async () => {
    const out = await shimRun('node-A', ['transcript', '--node', 'node-G'])
    expect(out).toContain('user: hello gemini')
    expect(out).toContain('assistant: hello back')
  })
  it('non-claude agent without a resolved path gets no cwd fallback', async () => {
    const out = await shimRun('node-A', ['summary', '--node', 'node-Y'])
    expect(out).toContain('no conversation transcript yet')
  })
  it('renders an opencode transcript via the export', async () => {
    const out = await shimRun('node-A', ['transcript', '--node', 'node-O'])
    expect(out).toContain('user: add rerank')
    expect(out).toContain('assistant: done, added rerank.ts')
    expect(out).toContain('$ bash npm test')
  })
  it('opencode without a session id reports friendly, does not throw', async () => {
    const out = await shimRun('node-A', ['summary', '--node', 'node-O2'])
    expect(out).toContain('has no session id yet')
  })

  // The whole point of Phase 2: the transcript is on another machine, and the desktop serves the
  // read over the project's ControlMaster. The command an agent types is unchanged.
  it('reads a REMOTE node through the same command', async () => {
    const out = await shimRun('node-A', ['summary', '--node', 'node-R'])
    expect(out).toContain('deploy the app')
    expect(asked.transcripts).toContain('node-R')
  })

  it('matches a node by title, case-insensitively', async () => {
    const out = await shimRun('node-A', ['summary', '--node', 'builder'])
    expect(out).toContain('deploy the app')
  })

  it('lists what IS linked when the target is unknown', async () => {
    const out = await shimRun('node-A', ['summary', '--node', 'nope'])
    expect(out).toContain('No linked node matches')
    expect(out).toContain('Builder')
  })

  // Authorization: a caller holding the hook token still only ever gets ITS OWN document.
  it('gives an unlinked node nothing, whatever it asks for', async () => {
    const out = await shimRun('node-Z', ['transcript', '--node', 'node-B'])
    expect(out).toContain('No linked nodes')
    expect(out).not.toContain('deploy the app')
  })
})
