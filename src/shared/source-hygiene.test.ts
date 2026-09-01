/**
 * A tracked source file must not contain a raw NUL byte.
 *
 * Git classifies a file containing a NUL as BINARY. It then renders as "Binary files differ" in
 * every diff surface — the PR page, `git diff`, `git log -p`, a review UI — and `git grep` skips
 * it entirely. The file still compiles and its tests still pass, so nothing fails; it simply
 * becomes invisible to review.
 *
 * That is how it actually happened here: `renderer/lib/nodeIconImage.ts` wrote its cache-key
 * separator as a literal NUL (`` `${projectId}<NUL>${absPath}` ``) rather than the escape
 * `\x00`. Identical at runtime — and by bad luck it hid the one new file performing `readBinary`
 * reads driven by persisted data, i.e. the file a reviewer most needed to see.
 *
 * A separator, a delimiter or a sentinel is a perfectly good reason to WANT a NUL; write it as an
 * escape and the file stays text. There is no legitimate reason for the raw byte to sit in source.
 */
import { execFileSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

const repoRoot = join(__dirname, '..', '..')

/** Tracked `.ts` / `.tsx` under `src/`. Asking git (not the filesystem) keeps build output,
 *  `node_modules` and anything gitignored out without a hand-maintained ignore list. */
function trackedSources(): string[] {
  return execFileSync('git', ['ls-files', '--', 'src'], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter((f) => f.endsWith('.ts') || f.endsWith('.tsx'))
}

describe('source hygiene', () => {
  it('has no tracked TypeScript source that git would classify as binary', () => {
    const files = trackedSources()
    // A guard that silently scanned nothing would pass forever. Pin that we actually looked.
    expect(files.length).toBeGreaterThan(100)

    const offenders = files.filter((f) => readFileSync(join(repoRoot, f)).includes(0x00))
    expect(offenders).toEqual([])
  })
})
