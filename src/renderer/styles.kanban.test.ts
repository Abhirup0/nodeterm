import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

// `.replace(/\r\n/g, '\n')` on every read below: a test that reads a checked-in file must not
// care how git checked it out. Git for Windows defaults to `core.autocrlf=true`, so a Windows
// clone has CRLF working files, and a slice on a literal containing `\n` (`indexOf('}\n}')`,
// `indexOf('\n}\n')`) then matches nothing and the assertion fails on a checkout with zero local
// changes (issue #578). `.gitattributes` is the durable half of the fix; this is the half that
// survives a working tree that was checked out before it landed.
const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')
const VIEW = readFileSync(join(__dirname, 'components/kanban/KanbanView.tsx'), 'utf8').replace(/\r\n/g, '\n')

describe('Kanban column row layout', () => {
  it('stretches empty columns to the height of the tallest column without filling the viewport', () => {
    expect(VIEW).toContain('className="kanban-board__columns"')
    expect(CSS).toMatch(
      /\.kanban-board__columns\s*{[^}]*display:\s*flex;[^}]*align-items:\s*stretch;[^}]*height:\s*fit-content;/s
    )
  })
})
