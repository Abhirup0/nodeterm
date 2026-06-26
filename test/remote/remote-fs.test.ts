// Remote filesystem round-trip (Task 5).
//
// Wires the pure CLIENT handlers' `fs.*` RPC senders straight into the pure HOST handlers' `fs.*`
// RPC handlers via a fake relay pair (no sockets, no Electron). The host handlers run the REAL
// shared fs-ops against a real temp dir, so this proves the full client→host→fs round-trip:
//   client.fsWrite(tmp, 'hi')  →  host writes the real file
//   client.fsRead(tmp)         →  host reads it back  → 'hi'
//   client.fsList(tmpdir)      →  host lists it       → includes the file
//   client.fsReadBinary(tmp)   →  host reads base64   → decodes to 'hi'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  createHostHandlers,
  type HostPtyManager,
  type HostRelaySocket
} from '../../src/main/remote/host-service'
import {
  createClientHandlers,
  type ClientRelaySocket,
  type ClientSessionSinks
} from '../../src/main/remote/client-service'

// The fs RPCs never touch the PTY; a no-op pty-manager satisfies the host's required shape.
function noopPty(): HostPtyManager {
  return {
    createDetached: () => 'pty-1',
    attachDetached: () => 'pty-1',
    captureSnapshot: async () => '',
    write: () => {},
    resize: () => {},
    setFlow: () => {},
    kill: () => {}
  }
}

const noopSinks: ClientSessionSinks = { onData: () => {}, onExit: () => {} }

// A fake relay pair: the client's `rpc(method, params)` is routed straight into the host handlers'
// `onRpc` (resolved lazily so the host can be built after the pair), and the host's
// `respond(id, ok, body)` resolves the matching client promise. This is the synchronous in-memory
// equivalent of the relay carrying the request/response.
function fakePair(getHost: () => ReturnType<typeof createHostHandlers>) {
  let counter = 0
  const pending = new Map<string, (body: unknown) => void>()

  const hostSocket: HostRelaySocket = {
    respond: (id, _ok, body) => pending.get(id)?.(body),
    sendFrame: () => true
  }

  const clientSocket: ClientRelaySocket = {
    rpc: (method, params) =>
      new Promise((resolve) => {
        const id = `rpc-${++counter}`
        pending.set(id, resolve)
        getHost().onRpc({ id, method, params })
      }),
    sendFrame: () => true
  }

  return { hostSocket, clientSocket }
}

describe('remote filesystem round-trip (client fs RPC → host fs-ops → real temp dir)', () => {
  let dir = ''

  beforeAll(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nodeterm-remote-fs-'))
  })

  afterAll(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('writes, reads, lists and reads-binary a host file over the relay', async () => {
    // Build the host handlers first so the fake pair can route the client's RPCs into them; then
    // wire the host's `respond` back through the same pair.
    let host!: ReturnType<typeof createHostHandlers>
    const pair = fakePair(() => host)
    // The temp dir is the shared root so the client's fs.* RPCs are permitted (fs jail).
    host = createHostHandlers(noopPty(), pair.hostSocket, undefined, () => [dir])
    const client = createClientHandlers(pair.clientSocket, noopSinks)

    const file = path.join(dir, 'note.txt')

    // write
    expect(await client.fsWrite(file, 'hi')).toBe(true)
    expect(await fs.readFile(file, 'utf-8')).toBe('hi')

    // read
    expect(await client.fsRead(file)).toBe('hi')

    // list includes the new file
    const entries = await client.fsList(dir)
    expect(entries.map((e) => e.name)).toContain('note.txt')
    expect(entries.find((e) => e.name === 'note.txt')?.dir).toBe(false)

    // readBinary round-trips through base64
    const b64 = await client.fsReadBinary(file)
    expect(Buffer.from(b64, 'base64').toString('utf-8')).toBe('hi')
  })

  it('degrades to empty/false on host fs errors (read/list/write of a bad path)', async () => {
    let host!: ReturnType<typeof createHostHandlers>
    const pair = fakePair(() => host)
    host = createHostHandlers(noopPty(), pair.hostSocket, undefined, () => [dir])
    const client = createClientHandlers(pair.clientSocket, noopSinks)

    expect(await client.fsRead(path.join(dir, 'does-not-exist.txt'))).toBe('')
    expect(await client.fsList(path.join(dir, 'no-such-dir'))).toEqual([])
    expect(await client.fsWrite(path.join(dir, 'no', 'such', 'parent.txt'), 'x')).toBe(false)
  })
})
