import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8')
const DIALOG = readFileSync(join(__dirname, 'components', 'WorktreeDialog.tsx'), 'utf8')

describe('New Worktree existing-worktree list', () => {
  it('keeps large repositories inside a viewport-bounded scrolling list', () => {
    expect(DIALOG).toContain('className="bind-existing__list"')
    const rule = CSS.match(/\.bind-existing__list\s*\{([^}]*)\}/)?.[1] ?? ''
    expect(rule).toContain('max-height: min(260px, 32vh)')
    expect(rule).toContain('overflow-y: auto')
  })
})
