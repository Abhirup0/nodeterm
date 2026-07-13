// Stage 4c, task 1: the Server Edition's WS-RPC protocol (`src/shared/rpc.ts`) carried verbatim
// inside the relay's E2EE box. A remote tab is then "a Server Edition client whose socket happens
// to be a relay" — same frames, same ordering, encrypted end to end.
//
// Additive: the legacy opcode dialect (rpc/notify/respond/sendFrame) is untouched, so
// test/remote/relay-socket.test.ts and test/remote/framing.test.ts still pass unmodified.
import { describe, it, expect } from 'vitest'
import { connectRelay, type RelayTransport } from '../../src/main/remote/relay-socket'
import { genKeyPair, publicKeyToB64 } from '../../src/main/remote/e2ee'
import { encodePtyData, decodePtyData } from '../../src/shared/rpc'

// A pair of in-process fake duplex transports: whatever one `send`s is delivered asynchronously to
// the other's onMessage. Copied from test/remote/relay-socket.test.ts (that file is a merge gate —
// it must stay byte-for-byte unchanged, so it is duplicated rather than refactored into a helper).
function makeTransportPair(): { a: RelayTransport; b: RelayTransport } {
  let aOnMessage: ((data: unknown) => void) | null = null
  let bOnMessage: ((data: unknown) => void) | null = null
  let aOnClose: (() => void) | null = null
  let bOnClose: (() => void) | null = null
  let closed = false

  const deliver = (cb: ((data: unknown) => void) | null, data: unknown): void => {
    queueMicrotask(() => {
      if (!closed) cb?.(data)
    })
  }
  const teardown = (): void => {
    if (closed) return
    closed = true
    queueMicrotask(() => {
      aOnClose?.()
      bOnClose?.()
    })
  }

  const a: RelayTransport = {
    bufferedAmount: 0,
    send: (data) => deliver(bOnMessage, data),
    close: teardown,
    onMessage: (cb) => {
      aOnMessage = cb
    },
    onClose: (cb) => {
      aOnClose = cb
    }
  }
  const b: RelayTransport = {
    bufferedAmount: 0,
    send: (data) => deliver(aOnMessage, data),
    close: teardown,
    onMessage: (cb) => {
      bOnMessage = cb
    },
    onClose: (cb) => {
      bOnClose = cb
    }
  }
  return { a, b }
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

describe('relay tunnel — rpc.ts frames over the E2EE socket', () => {
  it('round-trips a text frame and a binary pty frame, and reports an honest bufferedAmount', async () => {
    const hostKeys = genKeyPair()
    const clientKeys = genKeyPair()
    const { a: ht, b: ct } = makeTransportPair()
    const seen: Array<{ kind: 'text' | 'binary'; text?: string; bin?: Uint8Array }> = []

    const host = connectRelay({
      url: 'wss://x/ws',
      token: 't',
      role: 'host',
      ourKeys: hostKeys,
      transport: ht,
      onReady: () => {},
      onRpc: () => {},
      onFrame: () => {},
      onClose: () => {},
      onTunnel: (kind, payload) =>
        seen.push(
          kind === 'text'
            ? { kind, text: new TextDecoder().decode(payload) }
            : { kind, bin: payload }
        )
    })

    const clientReady = deferred()
    const client = connectRelay({
      url: 'wss://x/ws',
      token: 't',
      role: 'client',
      ourKeys: clientKeys,
      theirPubB64: publicKeyToB64(hostKeys.publicKey),
      transport: ct,
      onReady: () => clientReady.resolve(),
      onRpc: () => {},
      onFrame: () => {},
      onClose: () => {}
    })
    await clientReady.promise

    expect(
      client.sendTunnelText(JSON.stringify({ t: 'req', id: 1, method: 'fs:list', args: ['/'] }))
    ).toBe(true)
    expect(client.sendTunnelBinary(encodePtyData('s1', 'hello'))).toBe(true)
    await new Promise((r) => setTimeout(r, 20))

    expect(seen.map((s) => s.kind)).toEqual(['text', 'binary'])
    expect(JSON.parse(seen[0]!.text!)).toEqual({ t: 'req', id: 1, method: 'fs:list', args: ['/'] })
    expect(decodePtyData(seen[1]!.bin!)).toEqual({ sessionId: 's1', data: 'hello' })
    expect(typeof client.bufferedAmount()).toBe('number')

    host.close()
    client.close()
  })

  // Single-stream FIFO: canvas convergence (Stage 3) relies on a server-stamped `seq` arriving
  // monotonically per client, which only holds on ONE ordered channel. Tunnel frames must therefore
  // ride the same E2EE stream as everything else, interleaved in send order — never a side channel.
  it('preserves send order across text, binary and legacy frames on the one stream', async () => {
    const hostKeys = genKeyPair()
    const clientKeys = genKeyPair()
    const { a: ht, b: ct } = makeTransportPair()
    const order: string[] = []

    const hostReady = deferred()
    const host = connectRelay({
      url: 'wss://x/ws',
      token: 't',
      role: 'host',
      ourKeys: hostKeys,
      transport: ht,
      onReady: () => hostReady.resolve(),
      onRpc: (msg) => order.push(`rpc:${msg.method}`),
      onFrame: () => order.push('frame'),
      onClose: () => {},
      onTunnel: (kind, payload) =>
        order.push(kind === 'text' ? `text:${new TextDecoder().decode(payload)}` : 'binary')
    })

    const clientReady = deferred()
    const client = connectRelay({
      url: 'wss://x/ws',
      token: 't',
      role: 'client',
      ourKeys: clientKeys,
      theirPubB64: publicKeyToB64(hostKeys.publicKey),
      transport: ct,
      onReady: () => clientReady.resolve(),
      onRpc: () => {},
      onFrame: () => {},
      onClose: () => {}
    })
    await Promise.all([hostReady.promise, clientReady.promise])

    client.sendTunnelText('1')
    client.sendTunnelBinary(encodePtyData('s', 'x'))
    client.notify('legacy', {})
    client.sendTunnelText('2')
    await new Promise((r) => setTimeout(r, 20))

    expect(order).toEqual(['text:1', 'binary', 'rpc:legacy', 'text:2'])

    host.close()
    client.close()
  })

  it('a tunnel frame sent before the handshake completes is refused (never leaks plaintext)', () => {
    const { a } = makeTransportPair()
    const s = connectRelay({
      url: 'wss://x/ws',
      token: 't',
      role: 'host',
      ourKeys: genKeyPair(),
      transport: a,
      onReady: () => {},
      onRpc: () => {},
      onFrame: () => {},
      onClose: () => {}
    })
    expect(s.sendTunnelText('{"t":"cast","method":"pty:write","args":[]}')).toBe(false)
    expect(s.sendTunnelBinary(encodePtyData('s1', 'x'))).toBe(false)
    expect(s.bufferedAmount()).toBe(0)
    s.close()
  })
})
