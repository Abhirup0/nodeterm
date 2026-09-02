// A test that reads a checked-in file must not care how git checked it out.
//
// Issue #578: with no `.gitattributes`, `text`/`eol` are unspecified, and Git for Windows defaults
// to `core.autocrlf=true` — so every Windows clone gets CRLF working files. A test that then slices
// on a literal containing `\n` (`CSS.indexOf('}\n}')`, `CSS.indexOf('\n}\n')`) matches nothing, the
// slice degenerates, and the assertion fails on a checkout with ZERO local changes. Two suites did
// exactly that, and the second one (`styles.theme.test.ts`) reported 25 colour tokens missing that
// were all present — a failure that reads like a real regression rather than a broken slice.
//
// Two halves, and this guard pins both:
//   1. `.gitattributes` normalizes the working tree on every platform. Durable, and it closes the
//      class rather than the instance.
//   2. The readers normalize anyway — which is what protects a working tree that was checked out
//      BEFORE the attributes file landed (they only take effect on re-checkout or
//      `git add --renormalize .`).
//
// Deliberately narrow: it only asks about test files that BOTH read a file and slice on a
// `\n`-bearing literal. A broad "every readFileSync must normalize" rule would fire on the many
// guard tests that read source and only ever use `includes`/regex, where the bytes do not matter.
import { describe, it, expect } from 'vitest'
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const REPO_ROOT = join(__dirname, '..', '..')
const SRC = join(REPO_ROOT, 'src')

function testFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) testFiles(full, out)
    else if (/\.test\.tsx?$/.test(entry)) out.push(full)
  }
  return out
}

/**
 * A search for a literal that contains an escaped newline AND something else — the shape that
 * breaks. `split('\n')` and a bare `indexOf('\n')` are deliberately excluded: they survive CRLF
 * (a stray `\r` is trimmed, or lands one character before a boundary the caller re-derives), and
 * including them would fire on a dozen guard tests that only ever line-split source.
 */
const NEWLINE_SLICE = /\b(indexOf|lastIndexOf)\(\s*(['"])(?=[^'"]*\\n)(?=[^'"]*[^'"\\n])[^'"]{2,}?\2/
/**
 * A read of a file that comes out of the git CHECKOUT — its path is built from `__dirname` or the
 * repo root. A test that reads a temp file it just WROTE (a fake curl's argv log) is unaffected by
 * how git checks anything out, so those are not the subject.
 */
const READ_CALL = /readFileSync\([^)]*(?:__dirname|repoRoot|REPO_ROOT)[^)]*\)/g
const NORMALIZED = /\.replace\(\/\\r\\n\/g,\s*'\\n'\)/

describe('line endings', () => {
  it('.gitattributes normalizes the working tree to LF on every platform', () => {
    const file = join(REPO_ROOT, '.gitattributes')
    expect(existsSync(file), '.gitattributes is missing — Windows clones will be CRLF').toBe(true)
    const text = readFileSync(file, 'utf8')
    expect(text).toMatch(/^\*\s+text=auto\s+eol=lf\s*$/m)
    // Windows entry points are the deliberate exception: cmd.exe is not reliably tolerant of LF,
    // and these are the files a Windows contributor runs before anything else works.
    expect(text).toMatch(/^\*\.bat\s+text\s+eol=crlf\s*$/m)
  })

  it('a test that slices on a \\n literal normalizes what it read', () => {
    const offenders: string[] = []
    for (const file of testFiles(SRC)) {
      if (file === __filename) continue // this file quotes the broken shapes in prose
      const source = readFileSync(file, 'utf8')
      if (!NEWLINE_SLICE.test(source)) continue
      for (const call of source.match(READ_CALL) ?? []) {
        const after = source.slice(source.indexOf(call) + call.length, source.indexOf(call) + call.length + 40)
        if (!NORMALIZED.test(after)) offenders.push(`${file.slice(REPO_ROOT.length + 1)}: ${call}`)
      }
    }
    expect(
      offenders,
      "these reads slice on a '\\n' literal but keep the bytes as checked out — append " +
        ".replace(/\\r\\n/g, '\\n') (issue #578)"
    ).toEqual([])
  })
})
