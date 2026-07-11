import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import WebSocket from 'ws'
import { startServer } from '../../src/server/index'
import { SESSION_COOKIE } from '../../src/server/http'
import { hookServer } from '../../src/core/agents/hook-server'
import { IPC } from '../../src/shared/ipc'

// End-to-end proof of the Phase-3b agent-status chain, exercised over real sockets:
//
//   hook script POST  →  loopback hook server  →  normalizeClaude  →  platform.broadcast
//                                                                        →  WS `agent:status`
//
// `startServer` boots the loopback hook server (`hookServer.start()`) and wires its normalized
// listener onto the platform (`wireAgentStatus`). We reproduce the EXACT POST the managed hook
// script sends — path `POST /hook/<agentId>`, an `x-www-form-urlencoded` body carrying `nodeId`
// plus a JSON `payload`, authenticated by the per-session bearer token in the
// `x-nodeterm-hook-token` header (see src/core/agents/hook-server.ts) — using the live
// port/token exposed by `hookServer.getPort()` / `hookServer.getToken()` after boot.
//
// The synthetic payload is a Claude `Stop` hook event, which `normalizeClaude` maps to
// `{ kind:'state', state:'done' }` (truthy → the platform listener fires → broadcast). A WS
// client (registered as a broadcast sink on connect) must then receive the `agent:status`
// event carrying that normalized state.
describe('agent-status e2e: hook POST → agent:status over ws', () => {
  let dataDir: string, close: () => Promise<void>, port: number, cookie: string

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-e2e-agst-'))
    const srv = await startServer({
      port: 0,
      host: '127.0.0.1',
      dataDir,
      rendererDir: path.join(dataDir, 'no-renderer'),
      insecureHttp: false,
      passwordSeed: 'agst-e2e-pw',
      // The loopback hook server still boots (that's what this test exercises); we only skip
      // merging the managed hook into the developer's real ~/.claude — it would point into
      // `dataDir`, which afterAll removes, leaving a dangling hook behind.
      installHooks: false
    })
    port = srv.port
    close = srv.close
    const res = await fetch(`http://127.0.0.1:${port}/auth/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: 'password=agst-e2e-pw',
      redirect: 'manual'
    })
    expect(res.status).toBe(303)
    cookie = res.headers.get('set-cookie')!.split(';')[0]
    expect(cookie).toContain(SESSION_COOKIE)
  }, 30_000)

  afterAll(async () => {
    await close?.()
    fs.rmSync(dataDir, { recursive: true, force: true })
  })

  it('a posted hook event is broadcast to the ws client as agent:status', async () => {
    // The boot step must have actually started the loopback hook server.
    const hookPort = hookServer.getPort()
    const hookToken = hookServer.getToken()
    expect(hookPort).toBeGreaterThan(0)
    expect(hookToken).not.toBe('')

    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } })
    await new Promise<void>((res, rej) => {
      ws.on('open', () => res())
      ws.on('error', rej)
    })

    const got = new Promise<Record<string, unknown>>((resolve) => {
      ws.on('message', (d, isBinary) => {
        if (isBinary) return
        const m = JSON.parse(d.toString()) as Record<string, unknown>
        if (m.t === 'ev' && m.channel === IPC.agentStatus) resolve(m)
      })
    })

    // Reproduce the managed hook script's POST exactly. A Claude `Stop` event normalizes to a
    // state change (done) → the platform listener fires → `agent:status` broadcast.
    const nodeId = 'e2e-node-1'
    const payload = JSON.stringify({
      hook_event_name: 'Stop',
      session_id: 'e2e-session-abc',
      is_interrupt: false,
      last_assistant_message: 'e2e done'
    })
    const body = `nodeId=${encodeURIComponent(nodeId)}&payload=${encodeURIComponent(payload)}`
    const hookRes = await fetch(`http://127.0.0.1:${hookPort}/hook/claude`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        'x-nodeterm-hook-token': hookToken
      },
      body
    })
    // The hook server always fails open with 204 (a broken hook must never block the agent).
    expect(hookRes.status).toBe(204)

    const ev = (await Promise.race([
      got,
      new Promise((_r, rej) => setTimeout(() => rej(new Error('no agent:status broadcast')), 10_000))
    ])) as Record<string, unknown>

    expect(ev.channel).toBe(IPC.agentStatus)
    // `platform.broadcast(channel, e)` serializes as `{ t:'ev', channel, args:[e] }`; the first
    // arg is the NormalizedAgentEvent produced by normalizeClaude for our Stop payload.
    const normalized = (ev.args as Array<Record<string, unknown>>)[0]
    expect(normalized.nodeId).toBe(nodeId)
    expect(normalized.agentId).toBe('claude')
    expect(normalized.kind).toBe('state')
    expect(normalized.state).toBe('done')
    expect(normalized.sessionId).toBe('e2e-session-abc')

    ws.close()
  }, 30_000)
})
