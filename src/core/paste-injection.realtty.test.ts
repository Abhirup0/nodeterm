// SECURITY — the framed injection, delivered to a REAL bracketed-paste-aware reader.
//
// The sibling `paste-injection.test.ts` asserts on the produced BYTES. This file trusts no parser
// of ours: it spawns a real pty running a real bash (readline turns bracketed paste on and
// announces it with `ESC[?2004h`), writes the framed body into it, and then asks the filesystem
// whether the attacker's trailing bytes were executed as KEYS.
//
// It exists for the reason `control-master.realsh.test.ts` exists: a structural test can only
// catch the tricks it was taught, and this repo has twice shipped a defect that a hand-rolled
// parser passed and the real thing caught. A paste frame is a promise made to somebody else's
// parser, so somebody else's parser has to be the judge.
//
// SCOPE, since it changed: `bracketedInjection` is no longer how `sendText` delivers. Both of its
// paths hand the payload to tmux and let `paste-buffer -p` insert the markers, which is what
// removed the tmux-3.7 version floor — `tmux-paste.realtmux.test.ts` is where THAT is proven,
// against a real tmux, on both the local and the SSH command lines, including these same escape
// payloads. What remains here is the one caller that still builds a frame in JS:
// `agents/agent-message.ts`, which frames a message envelope before handing it to `sendFramed`.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { execFileSync } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import * as pty from 'node-pty'
import { bracketedInjection, PASTE_END } from './paste-injection'

const ESC = '\x1b'
/** readline says "I have requested bracketed paste" with this — the same DECSET tmux tracks. */
const PASTE_ON = `${ESC}[?2004h`
/** Its output is not its own source text, so seeing it cannot be an echo of the input line. */
const SENTINEL_CMD = "printf 'NTDONE%s\\n' 42\r"
const SENTINEL_OUT = 'NTDONE42'

/**
 * bash's readline only implements bracketed paste from 5.1. macOS ships bash 3.2 as /bin/bash, so
 * look for a good one on PATH before falling back — and when there is none, say so loudly rather
 * than pretend the suite covered this.
 */
function findPasteAwareBash(): string | null {
  for (const candidate of ['/usr/local/bin/bash', '/opt/homebrew/bin/bash', '/bin/bash', '/usr/bin/bash']) {
    if (!fs.existsSync(candidate)) continue
    try {
      const v = execFileSync(candidate, ['-c', 'echo "${BASH_VERSINFO[0]}.${BASH_VERSINFO[1]}"'], {
        encoding: 'utf8'
      }).trim()
      const [maj, min] = v.split('.').map((n) => Number(n))
      if (maj > 5 || (maj === 5 && min >= 1)) return candidate
    } catch {
      // not a usable bash — try the next candidate
    }
  }
  return null
}

const BASH = findPasteAwareBash()

let work: string
let markerDir: string

beforeAll(() => {
  work = fs.mkdtempSync(path.join(os.tmpdir(), 'ntpaste-'))
  markerDir = path.join(work, 'm')
  fs.mkdirSync(markerDir)
})

afterAll(() => {
  if (work) fs.rmSync(work, { recursive: true, force: true })
})

const marker = (name: string): string => path.join(markerDir, name)

/**
 * Write `bytes` into a real bash on a real pty, then abort the line and run a sentinel command.
 *
 * The sentinel is what makes this deterministic rather than a sleep: bash consumes its input in
 * order, so once the sentinel's OUTPUT has appeared, anything the payload could have executed has
 * already executed. It doubles as the check that the frame actually CLOSED — a payload that
 * swallowed the closing marker leaves readline still collecting a paste, the sentinel never runs,
 * and this rejects.
 */
function deliver(bytes: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const term = pty.spawn(BASH as string, ['--norc', '--noprofile', '-i'], {
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
          reject(
            new Error(
              `bash never reached the sentinel — the paste frame may still be open. Output so far: ${JSON.stringify(out.slice(-400))}`
            )
          )
        )
      }
    }, 15_000)
    term.onData((d) => {
      out += d
      if (stage === 'wait-ready' && out.includes(PASTE_ON)) {
        stage = 'wait-sentinel'
        term.write(bytes)
        // ctrl-c clears whatever is composed, then the sentinel runs from a fresh prompt.
        setTimeout(() => term.write('\x03'), 120)
        setTimeout(() => term.write(SENTINEL_CMD), 200)
        return
      }
      if (stage === 'wait-sentinel' && out.includes(`${SENTINEL_OUT}\r\n`)) {
        finish(() => resolve(out))
      }
    })
  })
}

/** The one surviving JS framer: `agent-message.ts` builds exactly this for `sendFramed`. */
const localBody = (text: string, enter: boolean): string => bracketedInjection(text, enter)

const PATHS: Record<string, (text: string, enter: boolean) => string> = {
  envelope: localBody
}

const suite = BASH ? describe : describe.skip

suite('REAL bash: an escaping payload is never interpreted as keys', () => {
  for (const [pathName, build] of Object.entries(PATHS)) {
    it(
      `${pathName}: the end marker + Enter + a command does NOT run the command (dictation insert, enter=false)`,
      async () => {
        const m = marker(`${pathName}-cmd`)
        // The escape: close the paste early, submit, and run something.
        const body = build(`hello${PASTE_END}\rtouch ${m}\r`, false)
        const out = await deliver(body)
        expect(fs.existsSync(m), 'the payload EXECUTED — it escaped the frame').toBe(false)
        // …and the text still arrived, as content. The ESC is gone, its printable tail is not.
        expect(out).toContain('hello[201~')
        expect(out).not.toContain('command not found')
      },
      20_000
    )

    it(
      `${pathName}: the end marker + ctrl-u + a command does NOT run it, even with Enter appended`,
      async () => {
        const m = marker(`${pathName}-ctrlu`)
        // No newline anywhere in the payload: the whole attack is the early frame close plus
        // ctrl-u (kill-line), which would wipe the benign prefix and leave only the command for
        // the Enter that this delivery appends itself. The trailing ` #` comments out the frame's
        // own closing marker, which under the escape arrives as typed characters after the
        // command — without it the corrupted argument would hide the hit.
        const body = build(`SAFE${PASTE_END}\x15touch ${m} #`, true)
        await deliver(body)
        expect(fs.existsSync(m), 'ctrl-u was read as a KEY — the payload escaped the frame').toBe(
          false
        )
      },
      20_000
    )

    it(
      // A guard rather than a discriminator: bash's own parser survives ESC-ESC, so this one
      // passes with or without the sanitizer. It is here because not every receiver is bash, and
      // the byte-level test next door is the one that fails when the rule goes away.
      `${pathName}: a trailing bare ESC does not swallow the closing marker`,
      async () => {
        const m = marker(`${pathName}-tail`)
        // If the payload's trailing ESC joins the marker's own, the frame never closes and every
        // later byte — including the sentinel — is eaten as pasted text; `deliver` rejects then.
        const body = build(`hello${ESC}`, false)
        const out = await deliver(body)
        expect(out).toContain(SENTINEL_OUT)
        expect(fs.existsSync(m)).toBe(false)
      },
      20_000
    )

    it(
      `${pathName}: an embedded paste-START does not re-open the frame`,
      async () => {
        const m = marker(`${pathName}-start`)
        const body = build(`a${ESC}[200~b${PASTE_END}\rtouch ${m}\r`, false)
        await deliver(body)
        expect(fs.existsSync(m)).toBe(false)
      },
      20_000
    )
  }

  it('control: the SAME attack DOES execute when the payload is framed unsanitized', async () => {
    // The mutation check, run rather than described: this is the shipped framer with the
    // sanitizer removed. If this ever stops creating the marker, the tests above prove nothing.
    const m = marker('control')
    const payload = `hello${PASTE_END}\rtouch ${m}\r`
    const unsanitized = `${ESC}[200~${payload}${ESC}[201~`
    await deliver(unsanitized)
    expect(fs.existsSync(m), 'the attack no longer works — these tests are vacuous').toBe(true)
  }, 20_000)
})
