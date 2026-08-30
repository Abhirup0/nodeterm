// A child's stdin is a pipe, and a pipe's write failure is NOT a throw at the call site: Node
// re-emits it as an async 'error' EVENT on the stream, so a try/catch around `stdin.write(...)`
// is inert and an unhandled event kills the whole main process with the "Uncaught Exception:
// write EPIPE" dialog. Issue #382 taught this for process stdio (PR #395 guarded the log sink);
// the second wave was every OTHER naked child-stdin write in the tree — the AI commit-message
// spawn, `git credential fill`, the ssh run() leg, the codex app-server probe. Each looked
// correct in review, because on the happy path a pipe write never fails; the error needs the
// child to die mid-write, which is exactly what a CLI does when handed a flag it does not know.
//
// So the rule is enforced by scan, in the fs-atomic.guard.test.ts mold: any file that writes to
// a `stdin` stream must also attach an 'error' listener to one. File granularity is a tripwire,
// not a proof — a file can attach the listener to one child and leave another naked — but it is
// the shape every past regression had (a NEW file, or a new spawn in a file with no handler at
// all), and a reviewer pointed at the file by a red test can check the pairing in seconds.

import { describe, expect, it } from 'vitest'
import { readFileSync, readdirSync, statSync } from 'fs'
import { join, relative } from 'path'

const ROOTS = ['core', 'main', 'server', 'session-host'].map((d) => join(__dirname, '..', d))
const SOURCE_ROOT = join(__dirname, '..')

function sources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const p = join(dir, entry)
    if (statSync(p).isDirectory()) {
      if (entry !== 'node_modules') sources(p, out)
    } else if (/\.ts$/.test(entry) && !/\.test\.ts$/.test(entry)) {
      out.push(p)
    }
  }
  return out
}

/** Strip comments so a documented example cannot trip (or satisfy) the needles. String literals
 * are kept: a generated-sh template writing `stdin.write` into a script would be a real hazard in
 * the generated program too, and none exist today. */
function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
}

/** Every spelling a child-stdin write takes in this tree: `child.stdin.write(`,
 * `child.stdin?.end(`, `cp.stdin!.write(`, and a destructured/aliased `stdin.end(`. */
const WRITE_NEEDLE = /\bstdin[!?]*\.(?:write|end)\s*\(/
/** ...and the guard that makes those writes safe. */
const HANDLER_NEEDLE = /\bstdin[!?]*\.(?:on|once)\s*\(\s*['"]error['"]/

describe('every child-stdin writer handles the pipe error event', () => {
  const files = ROOTS.flatMap((r) => sources(r))

  it('finds the source tree (a zero-file scan would pass silently)', () => {
    expect(files.length).toBeGreaterThan(100)
  })

  it('no stdin write without an error listener in the same file', () => {
    const offenders: string[] = []
    for (const f of files) {
      const code = stripComments(readFileSync(f, 'utf8'))
      if (WRITE_NEEDLE.test(code) && !HANDLER_NEEDLE.test(code)) {
        offenders.push(relative(SOURCE_ROOT, f).replace(/\\/g, '/'))
      }
    }
    expect(
      offenders,
      'these write to a child stdin with no \'error\' listener on it — the EPIPE from a child ' +
        'that exits early is an async event, not a throw, and unhandled it crashes the app. ' +
        "Attach `child.stdin.on('error', ...)` (log via console.warn so the debug ring sees it, " +
        'or settle the pending call) before the first write; see tmux-control-client.ts and ' +
        'pty-manager.ts runWithStdin for the house pattern.'
    ).toEqual([])
  })

  it('the needles actually bite, and the guard patterns do not', () => {
    expect(WRITE_NEEDLE.test('child.stdin.write(payload)')).toBe(true)
    expect(WRITE_NEEDLE.test('child.stdin?.end(stdin)')).toBe(true)
    expect(WRITE_NEEDLE.test('cp.stdin!.write(s)')).toBe(true)
    expect(WRITE_NEEDLE.test('stdin.end(input)')).toBe(true)
    // A stdout write is a different stream with a different owner (the log sink).
    expect(WRITE_NEEDLE.test('process.stdout.write(line)')).toBe(false)
    // The handler spellings in the tree today.
    expect(HANDLER_NEEDLE.test("child.stdin.on('error', onErr)")).toBe(true)
    expect(HANDLER_NEEDLE.test("cp.stdin?.on('error', () => {})")).toBe(true)
    expect(HANDLER_NEEDLE.test("stdin.once('error', () => {})")).toBe(true)
    // Listening on the CHILD is not listening on the pipe — the crash the rule is about.
    expect(HANDLER_NEEDLE.test("child.on('error', () => {})")).toBe(false)
  })

  it('comments neither trip nor satisfy the scan', () => {
    expect(WRITE_NEEDLE.test(stripComments('// child.stdin.write(payload)'))).toBe(false)
    expect(HANDLER_NEEDLE.test(stripComments("// child.stdin.on('error', cb)"))).toBe(false)
  })
})
