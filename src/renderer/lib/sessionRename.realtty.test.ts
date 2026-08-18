// SECURITY — the composed `/rename` line, delivered to a REAL line reader.
//
// The sibling `sessionRename.test.ts` asserts on the produced BYTES with a splitter of our own.
// This file trusts no parser of ours: it spawns a real pty running a real bash and then asks the
// FILESYSTEM whether the attacker's second command ran. A structural test can only catch the
// tricks it was taught; a real reader already knows them all, and this repo has twice shipped a
// defect that a hand-rolled parser passed and the real thing caught.
//
// The delivery modelled is `PtyManager.sendText`'s un-framed branch — the text, then Enter. The
// paste-FRAMED branch would mask the splice (a CR inside a paste frame is content, not Enter), but
// which branch runs is decided by a probe of the RECEIVER, so the un-framed one is what a rename
// lands in whenever the agent CLI has not asked for bracketed paste. That is where the bug lives.
//
// The SSH delivery is not re-proved here — it cannot be, from the renderer project, which may not
// import `src/core`. It does not need to be: `control-master.test.ts` pins that the remote line
// carries the composed text TRANSPARENTLY (a CR in it survives the quoting and reaches the pane),
// which is the whole reason the fix has to live at composition rather than at either delivery.
//
// `core/paste-injection.realtty.test.ts` (#198) is the sibling of this file one layer down, and the
// two are deliberately NOT merged into one harness: that one proves the DELIVERY cannot let a
// payload escape its paste frame, this one proves the COMPOSITION cannot hand the delivery two
// lines in the first place — and they sit either side of a project boundary the renderer may not
// cross, so sharing the harness would mean parking a node-pty-importing helper in `@shared`, which
// both bundles pull in. The invariants are different; only the ~40 lines of pty plumbing rhyme.
//
// The last test is the mutation check, RUN rather than described: the same attack composed the old
// way (`/rename ${title}`) must still create the marker. If it ever stops, everything above is
// vacuous.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { renameCommand } from './sessionRename'

/**
 * node-pty is rebuilt for ELECTRON's ABI by this repo's postinstall (`electron-rebuild`), so a
 * plain-node vitest run cannot always load it. Ask, and SELF-SKIP rather than redden a suite over
 * a native binding this test does not own — the byte-level sibling covers the same invariant
 * everywhere, and this file is the extra proof, not the only one.
 */
let pty: typeof import('node-pty') | null = null
try {
  pty = await import('node-pty')
} catch {
  pty = null
}

/** Its output is not its own source text, so seeing it cannot be an echo of the input line. */
const SENTINEL_CMD = "printf 'NTDONE%s\\n' 42\r"
const SENTINEL_OUT = 'NTDONE42'

function findBash(): string | null {
  for (const c of ['/bin/bash', '/usr/bin/bash', '/usr/local/bin/bash', '/opt/homebrew/bin/bash']) {
    if (fs.existsSync(c)) return c
  }
  return null
}

const BASH = findBash()

let work: string
let markerDir: string

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'ntrename-'))
  markerDir = path.join(work, 'm')
  fs.mkdirSync(markerDir)
})

afterAll(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true })
})

const marker = (name: string): string => path.join(markerDir, name)

/**
 * Write `bytes` into a real bash on a real pty, then abort the line and run a sentinel.
 *
 * The sentinel is what makes this deterministic rather than a sleep: bash consumes its input in
 * order, so once the sentinel's OUTPUT has appeared, anything the payload could have executed has
 * already executed.
 */
function deliver(bytes: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const term = (pty as typeof import('node-pty')).spawn(BASH as string, ['--norc', '--noprofile', '-i'], {
      name: 'xterm-256color',
      cols: 200,
      rows: 40,
      cwd: work,
      env: { ...process.env, PS1: 'RDY> ', HISTFILE: '/dev/null', TERM: 'xterm-256color' }
    })
    let out = ''
    let stage: 'wait-ready' | 'wait-sentinel' | 'done' = 'wait-ready'
    const finish = (fn: () => void): void => {
      stage = 'done'
      clearTimeout(timer)
      try {
        term.kill()
      } catch {
        // the shell may already be gone
      }
      fn()
    }
    const timer = setTimeout(() => {
      if (stage !== 'done') {
        finish(() =>
          reject(new Error(`bash never reached the sentinel. Output: ${JSON.stringify(out.slice(-400))}`))
        )
      }
    }, 15_000)
    term.onData((d) => {
      out += d
      if (stage === 'wait-ready' && out.includes('RDY> ')) {
        stage = 'wait-sentinel'
        term.write(bytes)
        // ctrl-c clears whatever is composed, then the sentinel runs from a fresh prompt.
        setTimeout(() => term.write('\x03'), 120)
        setTimeout(() => term.write(SENTINEL_CMD), 220)
        return
      }
      if (stage === 'wait-sentinel' && out.includes(`${SENTINEL_OUT}\r\n`)) {
        finish(() => resolve(out))
      }
    })
  })
}

/** The delivery: the composed text, then the Enter `sendText` appends. */
const delivered = (line: string): string => `${line}\r`

const suite = BASH && pty ? describe : describe.skip

suite('REAL bash: a rename title cannot submit a second command', () => {
  it(
    'a CR in the title does NOT run the command that follows it',
    async () => {
      const m = marker('cr')
      const out = await deliver(delivered(renameCommand(`Deploy\rtouch ${m}`)))
      expect(fs.existsSync(m), 'the payload EXECUTED — the title spliced a second line').toBe(false)
      // …and the title still arrived, whole, as part of the rename.
      expect(out).toContain('/rename Deploy touch')
    },
    20_000
  )

  it(
    'an LF in the title does NOT run the command that follows it',
    async () => {
      const m = marker('lf')
      await deliver(delivered(renameCommand(`Deploy\ntouch ${m}`)))
      expect(fs.existsSync(m), 'LF was read as accept-line — the title spliced a second line').toBe(
        false
      )
    },
    20_000
  )

  it(
    'ctrl-u + a command does not run it either, even though the Enter is ours',
    async () => {
      // No line break anywhere: the attack is kill-line wiping the `/rename Deploy` prefix so
      // only the command is left for the Enter this delivery appends itself.
      const m = marker('ctrlu')
      await deliver(delivered(renameCommand(`Deploy\x15touch ${m}`)))
      expect(fs.existsSync(m), 'ctrl-u was read as a KEY — the title rewrote the line').toBe(false)
    },
    20_000
  )

  it(
    'an ordinary title still arrives, byte for byte',
    async () => {
      const out = await deliver(delivered(renameCommand('refactor the parser')))
      expect(out).toContain('/rename refactor the parser')
    },
    20_000
  )

  it('control: the SAME attack DOES run when the title is composed the old way', async () => {
    // The mutation check, run rather than described: this is the shipped composition with the
    // `oneLine` strip removed. If this ever stops creating the marker, the tests above prove
    // nothing at all.
    const m = marker('control')
    const title = `Deploy\rtouch ${m}`
    await deliver(delivered(`/rename ${title}`))
    expect(fs.existsSync(m), 'the attack no longer works — these tests are vacuous').toBe(true)
  }, 20_000)
})
