import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// `.replace(/\r\n/g, '\n')` on every read below: a test that reads a checked-in file must not
// care how git checked it out. Git for Windows defaults to `core.autocrlf=true`, so a Windows
// clone has CRLF working files, and a slice on a literal containing `\n` (`indexOf('}\n}')`,
// `indexOf('\n}\n')`) then matches nothing and the assertion fails on a checkout with zero local
// changes (issue #578). `.gitattributes` is the durable half of the fix; this is the half that
// survives a working tree that was checked out before it landed.
const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')
const DIALOG = readFileSync(join(__dirname, 'components', 'WorktreeDialog.tsx'), 'utf8').replace(/\r\n/g, '\n')

describe('New Worktree existing-worktree list', () => {
  it('keeps large repositories inside a viewport-bounded scrolling list', () => {
    expect(DIALOG).toContain('className="bind-existing__list"')
    const rule = CSS.match(/\.bind-existing__list\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toContain('max-height: min(260px, 32vh)')
    expect(rule).toContain('overflow-y: auto')
  })

  it('offers a branch/path search before the scrolling list', () => {
    expect(DIALOG).toContain('aria-label="Search existing worktrees"')
    expect(DIALOG.indexOf('bind-existing__search')).toBeLessThan(
      DIALOG.indexOf('bind-existing__list')
    )
  })
})
