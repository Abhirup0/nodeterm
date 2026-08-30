// Repro for the "Uncaught Exception: write EPIPE" dialog (issue #382's class, second wave).
//
// spawnAgent pipes the whole prompt (a staged diff can be 200 KB) into the agent CLI's stdin.
// When the CLI exits before draining it — bad flag, instant auth failure, crash on boot — the
// kernel closes the pipe's read end and the pending write fails with EPIPE. That failure does NOT
// arrive as a throw at `child.stdin.write(...)`: Node re-emits it as an async 'error' EVENT on the
// stdin stream, so a try/catch around the write is inert (measured in #382 for stdio; same
// mechanics here), and with no 'error' listener the event became an uncaught exception that put an
// error dialog over the whole app.
//
// The fake CLI below exits without reading a byte, and the prompt is far larger than the kernel
// pipe buffer (64 KB on Linux), so the EPIPE is deterministic. Before the fix the trap catches an
// EPIPE uncaught exception; after it, the handler logs and the call resolves normally.

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import os from 'os'
import { join } from 'path'
import { runAgent } from './commit-message'
import type { Settings } from '../shared/types'

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe.skipIf(process.platform === 'win32')('agent stdin EPIPE stays inside the call', () => {
  let dir: string
  let uncaught: unknown[]
  const trap = (e: unknown): void => {
    uncaught.push(e)
  }

  beforeEach(() => {
    dir = mkdtempSync(join(os.tmpdir(), 'nt-epipe-'))
    uncaught = []
    process.on('uncaughtException', trap)
  })

  afterEach(() => {
    process.removeListener('uncaughtException', trap)
    rmSync(dir, { recursive: true, force: true })
  })

  it('an agent CLI that exits without reading its prompt does not crash the process', async () => {
    const fakeCli = join(dir, 'fake-agent')
    // Exits immediately, never reads stdin — the shape of a CLI refusing its flags.
    writeFileSync(fakeCli, '#!/bin/sh\nexit 7\n')
    chmodSync(fakeCli, 0o755)

    const settings = {
      commitAgent: 'custom',
      commitAgentCommand: fakeCli,
      commitExtraPrompt: ''
    } as unknown as Settings

    // Far past the 64 KB pipe buffer, so the write is still in flight when the child dies.
    const prompt = 'x'.repeat(1024 * 1024)
    const res = await runAgent(prompt, dir, settings)

    // The failure is reported through the call's own contract...
    expect(res.ok).toBe(false)
    // ...and the EPIPE stays an event the handler consumed, never an uncaught exception. The
    // 'error' event fires on a later tick than the close that resolved us, so give it room.
    await wait(150)
    expect(uncaught).toEqual([])
  })
})
