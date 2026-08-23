import fs from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { Terminal } from '@xterm/headless'
import { afterEach, describe, expect, it } from 'vitest'
import { sessionHostPaths } from '../session-host/paths'
import {
  LineFramer,
  SESSION_HOST_PROTOCOL_VERSION,
  encodeFrame,
  type SessionHostRequest
} from '../session-host/protocol'
import { TerminalEmulator } from '../session-host/terminal-emulator'
import { SessionHostClient } from './session-host-client'

const openServers = new Set<net.Server>()
const openSockets = new Set<net.Socket>()
const tempDirs = new Set<string>()
const terminals = new Set<Terminal>()
const emulators = new Set<TerminalEmulator>()

function within<T>(promise: Promise<T>, ms = 1_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`session-host reconnect repaint did not finish within ${ms}ms`)),
      ms
    )
    promise.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error) => {
        clearTimeout(timer)
        reject(error)
      }
    )
  })
}

function writeTerminal(term: Terminal, data: string): Promise<void> {
  return new Promise<void>((resolve) => term.write(data, resolve))
}

function activeLines(term: Terminal): string[] {
  const buffer = term.buffer.active
  return Array.from({ length: buffer.length }, (_, index) =>
    buffer.getLine(index)?.translateToString(true) ?? ''
  )
}

function markerCount(lines: string[], marker: string): number {
  return lines.reduce((count, line) => count + line.split(marker).length - 1, 0)
}

async function listen(server: net.Server, endpoint: string): Promise<void> {
  openServers.add(server)
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(endpoint, resolve)
  })
}

afterEach(async () => {
  for (const terminal of terminals) terminal.dispose()
  terminals.clear()
  for (const emulator of emulators) emulator.dispose()
  emulators.clear()
  for (const socket of openSockets) socket.destroy()
  openSockets.clear()
  await Promise.all(
    [...openServers].map(
      (server) =>
        new Promise<void>((resolve) => {
          server.close(() => resolve())
        })
    )
  )
  openServers.clear()
  for (const dir of tempDirs) {
    const endpoint = sessionHostPaths(dir).endpoint
    if (process.platform !== 'win32') fs.rmSync(endpoint, { force: true })
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
  }
  tempDirs.clear()
})

describe('SessionHostClient reconnect repaint', () => {
  it('replaces the whole xterm buffer instead of appending a second serialized screen', async () => {
    const cols = 22
    const rows = 4
    const marker = 'RECONNECT-MARKER'
    const hostScreen = new TerminalEmulator({ cols, rows, scrollback: 100 })
    emulators.add(hostScreen)
    await hostScreen.write(
      '\x1b[?2004h\x1b[?1002h\x1b[?1006h' +
        [
          'history-01',
          'history-02',
          'history-03',
          marker,
          'history-05',
          'visible-01',
          'visible-02',
          'cursor-here'
        ].join('\r\n')
    )
    const screen = hostScreen.serialize(100)

    const expected = new Terminal({ cols, rows, scrollback: 100, allowProposedApi: true })
    terminals.add(expected)
    await writeTerminal(expected, screen)
    const expectedLines = activeLines(expected)
    expect(markerCount(expectedLines, marker)).toBe(1)
    expect(expected.buffer.active.length).toBeGreaterThan(rows)
    expect(expected.modes.bracketedPasteMode).toBe(true)
    expect(expected.modes.mouseTrackingMode).toBe('drag')

    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nodeterm-session-repaint-'))
    tempDirs.add(userDataDir)
    const paths = sessionHostPaths(userDataDir)
    fs.writeFileSync(paths.tokenPath, 'b'.repeat(64))
    fs.writeFileSync(
      paths.statePath,
      JSON.stringify({
        pid: process.pid,
        endpoint: paths.endpoint,
        tokenPath: paths.tokenPath,
        startedAt: Date.now(),
        protocolVersion: SESSION_HOST_PROTOCOL_VERSION
      })
    )

    // Protocol v2 requires attach/attachExisting/hasSession(exists:true) results to all carry a
    // matching generation (session-host-client.ts requireAttachResult / hasSession) — the exact
    // identity the reconnect path (restoreSocket -> 'attachExisting') cross-checks against what
    // the original 'attach' reported, refusing the warm replay otherwise.
    const generation = 'fixturegen01'
    let connection = 0
    let firstSocket: net.Socket | undefined
    let firstClosed!: () => void
    const firstSocketClosed = new Promise<void>((resolve) => {
      firstClosed = resolve
    })
    const server = net.createServer((socket) => {
      const ownConnection = ++connection
      if (ownConnection === 1) firstSocket = socket
      openSockets.add(socket)
      socket.once('close', () => {
        openSockets.delete(socket)
        if (ownConnection === 1) firstClosed()
      })
      const framer = new LineFramer()
      socket.on('data', (chunk: Buffer) => {
        for (const request of framer.push<SessionHostRequest>(chunk.toString('utf8'))) {
          if (request.cmd === 'hello') {
            // A real host (src/session-host/host.ts) always advertises its protocol version in
            // the hello result; the client negotiates against that, then cross-checks it against
            // the version this same fixture published in state.json. Omitting it here negotiates
            // the legacy (pre-v2) protocol while the state file claims v2, which the client
            // correctly refuses as an inconsistent host.
            socket.write(
              encodeFrame({
                id: request.id,
                ok: true,
                result: { protocolVersion: SESSION_HOST_PROTOCOL_VERSION }
              })
            )
          } else if (request.cmd === 'attach') {
            socket.write(
              encodeFrame({
                id: request.id,
                ok: true,
                result: { fresh: false, generation, screen }
              })
            )
          } else if (request.cmd === 'attachExisting') {
            // The reconnect path (restoreSocket) sends this on the second connection instead of
            // 'attach'. It must report the SAME generation the first 'attach' did, and the
            // serialized screen the client repaints the local xterm buffer with.
            socket.write(
              encodeFrame({
                id: request.id,
                ok: true,
                result: { fresh: false, generation, screen }
              })
            )
          } else if (request.cmd === 'hasSession') {
            socket.write(
              encodeFrame({ id: request.id, ok: true, result: { exists: true, generation } })
            )
          }
        }
      })
    })
    await listen(server, paths.endpoint)

    const actual = new Terminal({ cols, rows, scrollback: 100, allowProposedApi: true })
    terminals.add(actual)
    let repaintApplied!: () => void
    const repaintDone = new Promise<void>((resolve) => {
      repaintApplied = resolve
    })
    const client = new SessionHostClient({ userDataDir })
    const subscriber = {
      onData: (data: string) => {
        actual.write(data, repaintApplied)
      },
      onExit: () => {}
    }
    const attached = await within(
      client.attach(
        'nt-repaint',
        {
          cwd: userDataDir,
          shell: process.execPath,
          args: [],
          env: {},
          cols,
          rows
        },
        100,
        subscriber
      )
    )
    expect(attached.screen).toBe(screen)
    await writeTerminal(actual, attached.screen!)
    expect(activeLines(actual)).toEqual(expectedLines)

    firstSocket?.destroy()
    await within(firstSocketClosed)
    await expect(within(client.hasSession('nt-repaint'))).resolves.toBe(true)
    await within(repaintDone)

    const actualLines = activeLines(actual)
    expect(actual.buffer.active.length).toBe(expected.buffer.active.length)
    expect(actualLines).toEqual(expectedLines)
    expect(markerCount(actualLines, marker)).toBe(1)
    expect(actual.modes.bracketedPasteMode).toBe(true)
    expect(actual.modes.mouseTrackingMode).toBe('drag')
    client.unsubscribe('nt-repaint', subscriber)
  })
})
