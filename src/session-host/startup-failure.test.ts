import { afterEach, describe, expect, it } from 'vitest'
import { spawn, type ChildProcess } from 'child_process'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync
} from 'fs'
import net from 'net'
import os from 'os'
import path from 'path'
import { build, type Plugin } from 'esbuild'
import { sessionHostPaths } from './paths'
import { SESSION_HOST_PROTOCOL_VERSION } from './protocol'

interface ExitOutcome {
  code: number | null
  signal: NodeJS.Signals | null
  timedOut: boolean
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<ExitOutcome> {
  return new Promise((resolve) => {
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.once('exit', (code, signal) => {
      clearTimeout(timer)
      resolve({ code, signal, timedOut })
    })
  })
}

function endpointAcceptsConnections(endpoint: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(endpoint)
    let settled = false
    const finish = (connected: boolean): void => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(connected)
    }
    socket.once('connect', () => finish(true))
    socket.once('error', () => finish(false))
    socket.setTimeout(500, () => finish(false))
  })
}

function failureInjectionPlugin(): Plugin {
  return {
    name: 'session-host-startup-failure',
    setup(bundle) {
      bundle.onResolve({ filter: /^\.\/state-file$/ }, () => ({
        path: 'injected-state-file',
        namespace: 'startup-failure'
      }))
      bundle.onResolve({ filter: /^node-pty$/ }, () => ({
        path: 'node-pty',
        namespace: 'startup-failure'
      }))
      bundle.onLoad(
        { filter: /^injected-state-file$/, namespace: 'startup-failure' },
        () => ({
          loader: 'js',
          contents: `
            export function publishSessionHostState() {
              const error = new Error('injected state publication failure')
              error.code = 'ENOSPC'
              throw error
            }
          `
        })
      )
      bundle.onLoad({ filter: /^node-pty$/, namespace: 'startup-failure' }, () => ({
        loader: 'js',
        contents: `export function spawn() { throw new Error('node-pty must not spawn') }`
      }))
    }
  }
}

function inertPtyPlugin(): Plugin {
  return {
    name: 'session-host-inert-pty',
    setup(bundle) {
      bundle.onResolve({ filter: /^node-pty$/ }, () => ({
        path: 'node-pty',
        namespace: 'startup-failure'
      }))
      bundle.onLoad({ filter: /^node-pty$/, namespace: 'startup-failure' }, () => ({
        loader: 'js',
        contents: `export function spawn() { throw new Error('node-pty must not spawn') }`
      }))
    }
  }
}

async function buildAndStartHost(
  fixtureDir: string,
  dataDir: string,
  plugins: Plugin[]
): Promise<{ child: ChildProcess; bundlePath: string }> {
  const bundlePath = path.join(fixtureDir, 'host.cjs')
  await build({
    absWorkingDir: process.cwd(),
    entryPoints: ['src/session-host/host.ts'],
    outfile: bundlePath,
    bundle: true,
    platform: 'node',
    format: 'cjs',
    plugins,
    logLevel: 'silent'
  })
  return {
    bundlePath,
    child: spawn(process.execPath, [bundlePath, dataDir], {
      cwd: process.cwd(),
      stdio: 'ignore',
      windowsHide: true
    })
  }
}

const cleanupPaths: string[] = []
afterEach(() => {
  for (const target of cleanupPaths.splice(0)) rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 })
})

describe('session-host startup publication failure', () => {
  it('exits nonzero and leaves no listener, token, or startup lock behind', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'nt-session-host-process-'))
    cleanupPaths.push(fixtureDir)
    const dataDir = path.join(fixtureDir, 'user-data')
    mkdirSync(dataDir)
    const paths = sessionHostPaths(dataDir)
    if (process.platform !== 'win32') cleanupPaths.push(paths.endpoint)
    const { child } = await buildAndStartHost(fixtureDir, dataDir, [failureInjectionPlugin()])

    const outcome = await waitForExit(child, 5_000)

    expect(outcome.timedOut).toBe(false)
    expect(outcome.signal).toBeNull()
    expect(outcome.code).not.toBeNull()
    expect(outcome.code).not.toBe(0)
    expect(existsSync(paths.statePath)).toBe(false)
    expect(existsSync(paths.tokenPath)).toBe(false)
    await expect(endpointAcceptsConnections(paths.endpoint)).resolves.toBe(false)
  }, 15_000)
})

describe('session-host startup ownership reads', () => {
  it('does not reclaim a corrupt state file as though it were absent', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'nt-session-host-corrupt-state-'))
    cleanupPaths.push(fixtureDir)
    const dataDir = path.join(fixtureDir, 'user-data')
    mkdirSync(dataDir)
    const paths = sessionHostPaths(dataDir)
    if (process.platform !== 'win32') cleanupPaths.push(paths.endpoint)
    const original = '{broken ownership state'
    writeFileSync(paths.statePath, original)
    const { child } = await buildAndStartHost(fixtureDir, dataDir, [inertPtyPlugin()])

    const outcome = await waitForExit(child, 5_000)

    expect(outcome.timedOut).toBe(false)
    expect(outcome.code).not.toBe(0)
    expect(readFileSync(paths.statePath, 'utf8')).toBe(original)
    await expect(endpointAcceptsConnections(paths.endpoint)).resolves.toBe(false)
  }, 15_000)

  it('does not reclaim valid ownership whose token is empty/unreadable', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'nt-session-host-empty-token-'))
    cleanupPaths.push(fixtureDir)
    const dataDir = path.join(fixtureDir, 'user-data')
    mkdirSync(dataDir)
    const paths = sessionHostPaths(dataDir)
    if (process.platform !== 'win32') cleanupPaths.push(paths.endpoint)
    const state = JSON.stringify({
      pid: 42,
      endpoint: paths.endpoint,
      tokenPath: paths.tokenPath,
      startedAt: 1234,
      protocolVersion: SESSION_HOST_PROTOCOL_VERSION
    })
    writeFileSync(paths.statePath, state)
    writeFileSync(paths.tokenPath, '')
    const { child } = await buildAndStartHost(fixtureDir, dataDir, [inertPtyPlugin()])

    const outcome = await waitForExit(child, 5_000)

    expect(outcome.timedOut).toBe(false)
    expect(outcome.code).not.toBe(0)
    expect(readFileSync(paths.statePath, 'utf8')).toBe(state)
    expect(readFileSync(paths.tokenPath, 'utf8')).toBe('')
    await expect(endpointAcceptsConnections(paths.endpoint)).resolves.toBe(false)
  }, 15_000)

  it('leaves a directory occupying the ownership path untouched', async () => {
    const fixtureDir = mkdtempSync(path.join(os.tmpdir(), 'nt-session-host-state-dir-'))
    cleanupPaths.push(fixtureDir)
    const dataDir = path.join(fixtureDir, 'user-data')
    mkdirSync(dataDir)
    const paths = sessionHostPaths(dataDir)
    if (process.platform !== 'win32') cleanupPaths.push(paths.endpoint)
    mkdirSync(paths.statePath)
    const { child } = await buildAndStartHost(fixtureDir, dataDir, [inertPtyPlugin()])

    const outcome = await waitForExit(child, 5_000)

    expect(outcome.timedOut).toBe(false)
    expect(outcome.code).not.toBe(0)
    expect(statSync(paths.statePath).isDirectory()).toBe(true)
    await expect(endpointAcceptsConnections(paths.endpoint)).resolves.toBe(false)
  }, 15_000)
})
