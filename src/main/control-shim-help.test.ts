// `help` is answered by the shim itself, so it is tested the same way the flag loop is: the REAL
// script under REAL `sh`, with a `curl` that fails the run if it is called at all. A local answer
// that quietly round-trips would still pass a test that only inspected stdout.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { CONTROL_SHIM_SCRIPT, VERBS_FOR_TEST } from './canvas-control-core'

let dir = ''

const run = (args: string[]): string =>
  execFileSync('sh', [path.join(dir, 'shim.sh'), ...args], {
    env: {
      PATH: `${path.join(dir, 'bin')}:${process.env.PATH ?? ''}`,
      NODETERM_CANVAS_CONTROL: '1',
      NODETERM_HOOK_PORT: '1',
      NODETERM_NODE_ID: 'n1',
      HOME: dir
    },
    encoding: 'utf8'
  })

beforeAll(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ctlhelp-'))
  fs.mkdirSync(path.join(dir, 'bin'))
  fs.writeFileSync(path.join(dir, 'shim.sh'), CONTROL_SHIM_SCRIPT, { mode: 0o755 })
  // Any invocation is a failure: help must cost no network, so it also works while the app is down.
  fs.writeFileSync(path.join(dir, 'bin', 'curl'), '#!/bin/sh\nexit 77\n', { mode: 0o755 })
})

afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('the control shim answers help locally', () => {
  it.each(['help', '--help', '-h'])('%s prints usage without calling curl', (flag) => {
    const out = run([flag])
    expect(out).toContain('usage:')
    expect(out).toContain('Verbs:')
  })

  it('lists every registered verb — the list is derived, not re-typed', () => {
    // The reason `help` exists is that the verb set was undiscoverable from the CLI. A hand-copied
    // list would go stale on the first verb added and put us back where we started, so this asserts
    // against the registry itself.
    const out = run(['help'])
    for (const verb of VERBS_FOR_TEST) expect(out).toContain(verb)
  })

  it('points at the skill for per-verb flags rather than restating them', () => {
    // Flags are documented once, in the generated bodies. A second copy inside the shim is a second
    // thing to keep in sync, and the shim is the copy that goes stale on an SSH host until reconnect.
    expect(run(['help'])).toContain('manage-nodeterm-canvas')
  })
})
