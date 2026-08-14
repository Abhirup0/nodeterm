// End-to-end test for the POSIX-sh canvas-control CLI: the real shim script, run by the real
// /bin/sh, against the real hook server. The shim is generated source that no compiler ever
// checks, and it is the ONLY canvas-control client after the Electron-as-Node CLI was retired —
// a quoting slip in it fails silently at runtime on the user's machine (and, for SSH projects,
// on a machine we cannot even inspect). So it is exercised for real rather than asserted against.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { CONTROL_SHIM_SCRIPT } from './canvas-control-core'
import { hookServer, parseControlBody } from '../core/agents/hook-server'
import { initPlatform, resetPlatformForTests } from '../core/platform'
import { fakePlatform } from '../core/platform-fake'

const run = promisify(execFile)

let dir = ''
let shim = ''
let received: { verb: string; nodeId: string; args: Record<string, string> }[] = []

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-shim-'))
  resetPlatformForTests()
  initPlatform(fakePlatform({ userDataDir: dir }))
  shim = path.join(dir, 'nodeterm.sh')
  fs.writeFileSync(shim, CONTROL_SHIM_SCRIPT, { mode: 0o755 })
  await hookServer.start()
  hookServer.setControlHandler(async (cmd) => {
    received.push(cmd)
    if (cmd.verb === 'boom') return { ok: false, error: 'that verb exploded' }
    return { ok: true, message: `did ${cmd.verb}` }
  })
})

afterAll(() => {
  hookServer.stop()
  fs.rmSync(dir, { recursive: true, force: true })
})

/** Invoke the shim the way an agent does, with the env a nodeterm-spawned session carries. */
function callShim(
  args: string[],
  env: Record<string, string> = {}
): Promise<{ stdout: string; stderr: string }> {
  return run('/bin/sh', [shim, ...args], {
    env: {
      PATH: process.env.PATH ?? '',
      NODETERM_CANVAS_CONTROL: '1',
      NODETERM_NODE_ID: 'node-1',
      NODETERM_HOOK_PORT: String(hookServer.getPort()),
      NODETERM_HOOK_TOKEN: hookServer.getToken(),
      ...env
    }
  })
}

describe('canvas-control shim', () => {
  beforeAll(() => {
    received = []
  })

  it('is valid POSIX sh', async () => {
    await expect(run('/bin/sh', ['-n', shim])).resolves.toBeTruthy()
  })

  it('sends verb, node id and --flag pairs, and prints the server message', async () => {
    const { stdout } = await callShim(['open-claude', '--count', '2', '--cwd', '/srv/app'])
    expect(stdout.trim()).toBe('did open-claude')
    const last = received.at(-1)
    expect(last?.verb).toBe('open-claude')
    expect(last?.nodeId).toBe('node-1')
    expect(last?.args).toEqual({ count: '2', cwd: '/srv/app' })
  })

  it('defaults to `list` when called with no verb', async () => {
    await callShim([])
    expect(received.at(-1)?.verb).toBe('list')
  })

  // The reason this transport is form-urlencoded rather than JSON: these values reach curl as
  // ordinary argv and must survive verbatim. Hand-rolled JSON quoting in sh broke on every one.
  it('carries values containing quotes, newlines, $ and backslashes verbatim', async () => {
    const nasty = 'He said "hi";\nrm -rf $HOME `echo x` \\ 100% & <tag>'
    await callShim(['open-claude', '--prompt', nasty])
    expect(received.at(-1)?.args.prompt).toBe(nasty)
  })

  it('carries a JSON --team payload through unchanged', async () => {
    const team = JSON.stringify([{ title: 'UI', prompt: 'build the "header"', agent: 'claude' }])
    await callShim(['spawn-team', '--label', 'Frontend', '--team', team])
    expect(received.at(-1)?.args.team).toBe(team)
  })

  it('maps the bare positional to --path / --node per verb', async () => {
    await callShim(['show-image', '/tmp/a b.png'])
    expect(received.at(-1)?.args).toEqual({ path: '/tmp/a b.png' })
    await callShim(['close', 'node-9'])
    expect(received.at(-1)?.args).toEqual({ node: 'node-9' })
  })

  it('accepts a trailing flag with no value', async () => {
    await callShim(['rename', '--node', 'n1', '--title'])
    expect(received.at(-1)?.args).toEqual({ node: 'n1', title: '' })
  })

  it('carries the kanban verbs (board / assign) through', async () => {
    await callShim(['board'])
    expect(received.at(-1)).toMatchObject({ verb: 'board', args: {} })
    await callShim(['assign', '--node', 'node-7', '--column', 'In Progress'])
    expect(received.at(-1)).toMatchObject({ verb: 'assign', args: { node: 'node-7', column: 'In Progress' } })
  })

  it('carries the frame verbs (ungroup / move) through', async () => {
    await callShim(['ungroup', '--group', 'g1'])
    expect(received.at(-1)).toMatchObject({ verb: 'ungroup', args: { group: 'g1' } })
    await callShim(['move', '--nodes', 'n1,n2', '--group', 'g2'])
    expect(received.at(-1)).toMatchObject({ verb: 'move', args: { nodes: 'n1,n2', group: 'g2' } })
  })

  it('reports server-side failures on stderr with a non-zero exit', async () => {
    await expect(callShim(['boom'])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('that verb exploded')
    })
  })

  it('refuses outside a canvas-control session instead of calling anything', async () => {
    const before = received.length
    await expect(
      run('/bin/sh', [shim, 'list'], { env: { PATH: process.env.PATH ?? '' } })
    ).rejects.toMatchObject({ stderr: expect.stringContaining('not a nodeterm agent node') })
    expect(received.length).toBe(before)
  })

  it('rejects a wrong token (the server answers 403, the shim exits non-zero)', async () => {
    await expect(callShim(['list'], { NODETERM_HOOK_TOKEN: 'wrong' })).rejects.toMatchObject({
      code: 1
    })
  })

  it('says so when no endpoint is advertised at all', async () => {
    await expect(
      callShim(['list'], { NODETERM_HOOK_PORT: '', NODETERM_HOOK_TOKEN: '' })
    ).rejects.toMatchObject({ stderr: expect.stringContaining('endpoint unavailable') })
  })

  // The SSH path: the endpoint file is the only place a remote session learns its socket/token,
  // and it is re-read per invocation so a session that outlived an app restart still connects.
  it('sources sock/token from the endpoint file rather than the env', async () => {
    const endpoint = path.join(dir, 'hook-endpoint.env')
    fs.writeFileSync(
      endpoint,
      `NODETERM_HOOK_PORT=${hookServer.getPort()}\nNODETERM_HOOK_TOKEN=${hookServer.getToken()}\n`
    )
    const { stdout } = await callShim(['list'], {
      NODETERM_HOOK_PORT: '',
      NODETERM_HOOK_TOKEN: '',
      NODETERM_HOOK_ENDPOINT: endpoint
    })
    expect(stdout.trim()).toBe('did list')
  })
})

// The branch every SSH project actually uses. On a remote host there is no loopback port to
// reach the desktop on — only the reverse-forwarded unix socket — so if this branch is broken
// the feature is broken on exactly the surface it was built for, and nowhere else.
describe('canvas-control shim over a unix socket', () => {
  let sock = ''
  let server: import('node:http').Server
  // A holder plus an accessor rather than a bare `let`: clearing it in one test would otherwise
  // narrow the variable to `never` for every read that follows in the same flow.
  const state: { seen: { path: string; token: string; body: string } | null } = { seen: null }
  const lastSeen = (): typeof state.seen => state.seen

  beforeAll(async () => {
    const http = await import('node:http')
    sock = path.join(dir, 'hook.sock')
    server = http.createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        state.seen = {
          path: req.url ?? '',
          token: String(req.headers['x-nodeterm-hook-token'] ?? ''),
          body
        }
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('opened 2 sessions\n')
      })
    })
    await new Promise<void>((r) => server.listen(sock, r))
  })

  afterAll(() => {
    server.close()
  })

  it('posts through the socket and prints the reply', async () => {
    const { stdout } = await callShim(['open-claude', '--count', '2'], {
      NODETERM_HOOK_PORT: '',
      NODETERM_HOOK_SOCK: sock,
      NODETERM_HOOK_TOKEN: 'tok-remote'
    })
    expect(stdout.trim()).toBe('opened 2 sessions')
    expect(lastSeen()?.path).toBe('/control/open-claude')
    expect(lastSeen()?.token).toBe('tok-remote')
    expect(parseControlBody(lastSeen()?.body ?? '', 'application/x-www-form-urlencoded')).toEqual({
      nodeId: 'node-1',
      args: { count: '2' }
    })
  })

  it('carries a comma-joined --to list through unmangled (link)', async () => {
    state.seen = null
    await callShim(['link', '--to', 'n2,n3', '--from', 'n1'], {
      NODETERM_HOOK_PORT: '',
      NODETERM_HOOK_SOCK: sock,
      NODETERM_HOOK_TOKEN: 'tok-remote'
    })
    expect(lastSeen()?.path).toBe('/control/link')
    expect(parseControlBody(lastSeen()?.body ?? '', 'application/x-www-form-urlencoded')).toEqual({
      nodeId: 'node-1',
      args: { to: 'n2,n3', from: 'n1' }
    })
  })

  it('prefers the socket over a port when both are advertised', async () => {
    state.seen = null
    await callShim(['list'], { NODETERM_HOOK_SOCK: sock })
    expect(lastSeen()?.path).toBe('/control/list')
  })

  it('fails loudly when the socket is dead rather than hanging or printing success', async () => {
    await expect(
      callShim(['list'], {
        NODETERM_HOOK_PORT: '',
        NODETERM_HOOK_SOCK: path.join(dir, 'no-such.sock')
      })
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Could not reach nodeterm') })
  })
})

// The per-node token (task A10). The shim's job is only to PRESENT it: read the file the endpoint
// advertises, keyed by this node's id, and put it on every request — on BOTH transports.
//
// One environment fact, stated once: curl DROPS a header whose value is empty (`-H "X: ${empty}"`
// sends nothing at all). That is the contract we want — absent and empty are the same `legacy` to
// the server — so "empty header" below is read as `headers[...] ?? ''`.
describe('canvas-control shim presents the per-node token', () => {
  const seen: { path: string; nodeToken: string }[] = []
  let tcp: import('node:http').Server
  let unix: import('node:http').Server
  let tcpPort = 0
  let sock = ''
  let tokenDir = ''

  beforeAll(async () => {
    const http = await import('node:http')
    const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse): void => {
      req.resume()
      req.on('end', () => {
        seen.push({
          path: req.url ?? '',
          nodeToken: String(req.headers['x-nodeterm-node-token'] ?? '')
        })
        res.writeHead(200, { 'content-type': 'text/plain; charset=utf-8' })
        res.end('ok\n')
      })
    }
    tcp = http.createServer(handler)
    unix = http.createServer(handler)
    await new Promise<void>((r) => tcp.listen(0, '127.0.0.1', r))
    tcpPort = (tcp.address() as { port: number }).port
    sock = path.join(dir, 'token-probe.sock')
    await new Promise<void>((r) => unix.listen(sock, r))
    tokenDir = path.join(dir, 'node-tokens')
    fs.mkdirSync(tokenDir, { recursive: true })
    fs.writeFileSync(path.join(tokenDir, 'node-1'), 'CANVAS-NODE-TOKEN\n', { mode: 0o600 })
  })

  afterAll(() => {
    tcp.close()
    unix.close()
  })

  it('sends it over the TCP branch when the file exists', async () => {
    seen.length = 0
    await callShim(['list'], { NODETERM_HOOK_PORT: String(tcpPort), NODETERM_NODE_TOKEN_DIR: tokenDir })
    expect(seen).toEqual([{ path: '/control/list', nodeToken: 'CANVAS-NODE-TOKEN' }])
  })

  it('sends it over the unix-socket branch too (the SSH path)', async () => {
    seen.length = 0
    await callShim(['list'], {
      NODETERM_HOOK_PORT: '',
      NODETERM_HOOK_SOCK: sock,
      NODETERM_NODE_TOKEN_DIR: tokenDir
    })
    expect(seen).toEqual([{ path: '/control/list', nodeToken: 'CANVAS-NODE-TOKEN' }])
  })

  it('reads the dir out of the endpoint file, not only the env', async () => {
    seen.length = 0
    const endpoint = path.join(dir, 'token-endpoint.env')
    fs.writeFileSync(
      endpoint,
      `NODETERM_HOOK_PORT=${tcpPort}\nNODETERM_HOOK_TOKEN=whatever\nNODETERM_HOOK_VERSION=2\nNODETERM_NODE_TOKEN_DIR=${tokenDir}\n`
    )
    await callShim(['list'], {
      NODETERM_HOOK_PORT: '',
      NODETERM_HOOK_TOKEN: '',
      NODETERM_HOOK_ENDPOINT: endpoint
    })
    expect(seen).toEqual([{ path: '/control/list', nodeToken: 'CANVAS-NODE-TOKEN' }])
  })

  it('still calls, with an empty token, when no token file exists', async () => {
    seen.length = 0
    const empty = path.join(dir, 'no-tokens')
    fs.mkdirSync(empty, { recursive: true })
    await callShim(['list'], { NODETERM_HOOK_PORT: String(tcpPort), NODETERM_NODE_TOKEN_DIR: empty })
    expect(seen).toEqual([{ path: '/control/list', nodeToken: '' }])
  })

  it('never presents ANOTHER node\'s token file — the path is keyed by $NODETERM_NODE_ID', async () => {
    seen.length = 0
    await callShim(['list'], {
      NODETERM_HOOK_PORT: String(tcpPort),
      NODETERM_NODE_TOKEN_DIR: tokenDir,
      NODETERM_NODE_ID: 'node-9'
    })
    expect(seen).toEqual([{ path: '/control/list', nodeToken: '' }])
  })
})

describe('parseControlBody', () => {
  it('reads the shim dialect: nodeId plus arg.<name> fields', () => {
    expect(
      parseControlBody('nodeId=n1&arg.count=2&arg.cwd=%2Fsrv&version=1', 'application/x-www-form-urlencoded')
    ).toEqual({ nodeId: 'n1', args: { count: '2', cwd: '/srv' } })
  })

  it('still reads the JSON dialect the desktop callers use', () => {
    expect(parseControlBody('{"nodeId":"n1","args":{"a":"b"}}', 'application/json')).toEqual({
      nodeId: 'n1',
      args: { a: 'b' }
    })
  })

  it('degrades to an empty command on garbage rather than throwing', () => {
    expect(parseControlBody('not json', 'application/json')).toEqual({ nodeId: '', args: {} })
  })
})
