import { describe, it, expect } from 'vitest'
import { connectRelay, type RelayTransport } from '../../src/main/remote/relay-socket'
import { genKeyPair, publicKeyToB64 } from '../../src/main/remote/e2ee'
import { OP, decodeFrame, type Frame } from '../../src/main/remote/framing'

// A pair of in-process fake duplex transports: whatever one `send`s is delivered
// asynchronously to the other's onMessage. No real network, no `ws`.
function makeTransportPair(): { a: RelayTransport; b: RelayTransport } {
  let aOnMessage: ((data: unknown) => void) | null = null
  let bOnMessage: ((data: unknown) => void) | null = null
  let aOnClose: (() => void) | null = null
  let bOnClose: (() => void) | null = null
  let closed = false

  const deliver = (cb: ((data: unknown) => void) | null, data: unknown): void => {
    // Async delivery models a real socket and keeps the handshake event-driven.
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

describe('relay-socket', () => {
  it('completes the host<->client handshake and round-trips an RPC + a frame', async () => {
    const hostKeys = genKeyPair()
    const clientKeys = genKeyPair()
    const { a: hostTransport, b: clientTransport } = makeTransportPair()

    const hostReady = deferred()
    const clientReady = deferred()
    const receivedFrames: Frame[] = []

    const host = connectRelay({
      url: 'wss://relay.example/ws',
      token: 'pairing-token',
      role: 'host',
      ourKeys: hostKeys,
      transport: hostTransport,
      onReady: () => hostReady.resolve(),
      onRpc: (msg) => {
        // The host answers a ping request.
        if (msg.method === 'ping') {
          host.respond(msg.id, true, { pong: true })
        }
      },
      onFrame: (f) => {
        receivedFrames.push(f)
      },
      onClose: () => {}
    })

    const client = connectRelay({
      url: 'wss://relay.example/ws',
      token: 'pairing-token',
      role: 'client',
      ourKeys: clientKeys,
      theirPubB64: publicKeyToB64(hostKeys.publicKey),
      transport: clientTransport,
      onReady: () => clientReady.resolve(),
      onRpc: () => {},
      onFrame: () => {},
      onClose: () => {}
    })

    await Promise.all([hostReady.promise, clientReady.promise])

    // RPC round-trip: client -> host -> resolved result.
    const result = await client.rpc('ping', { hello: 'world' })
    expect(result).toEqual({ pong: true })

    // Binary frame: client -> host, decoded on the host's onFrame.
    const payload = new TextEncoder().encode('terminal output')
    const ok = client.sendFrame(OP.Output, 7, 42, payload)
    expect(ok).toBe(true)

    // Wait for async delivery.
    await new Promise((r) => setTimeout(r, 20))
    expect(receivedFrames.length).toBe(1)
    const frame = receivedFrames[0]!
    expect(frame.op).toBe(OP.Output)
    expect(frame.streamId).toBe(7)
    expect(frame.seq).toBe(42)
    expect(new TextDecoder().decode(frame.payload)).toBe('terminal output')

    host.close()
    client.close()
  })

  it('delivers a host->client notify to the client onRpc with an empty id', async () => {
    const hostKeys = genKeyPair()
    const clientKeys = genKeyPair()
    const { a: hostTransport, b: clientTransport } = makeTransportPair()

    const hostReady = deferred()
    const clientReady = deferred()
    const received: { id: string; method: string; params: unknown }[] = []

    const host = connectRelay({
      url: 'wss://relay.example/ws',
      token: 'pairing-token',
      role: 'host',
      ourKeys: hostKeys,
      transport: hostTransport,
      onReady: () => hostReady.resolve(),
      onRpc: () => {},
      onFrame: () => {},
      onClose: () => {}
    })

    const client = connectRelay({
      url: 'wss://relay.example/ws',
      token: 'pairing-token',
      role: 'client',
      ourKeys: clientKeys,
      theirPubB64: publicKeyToB64(hostKeys.publicKey),
      transport: clientTransport,
      onReady: () => clientReady.resolve(),
      onRpc: (msg) => received.push(msg),
      onFrame: () => {},
      onClose: () => {}
    })

    await Promise.all([hostReady.promise, clientReady.promise])

    const ok = host.notify('canvas:state', { nodes: [{ id: 'a' }] })
    expect(ok).toBe(true)

    await new Promise((r) => setTimeout(r, 20))
    expect(received).toEqual([
      { id: '', method: 'canvas:state', params: { nodes: [{ id: 'a' }] } }
    ])

    host.close()
    client.close()
  })
})
