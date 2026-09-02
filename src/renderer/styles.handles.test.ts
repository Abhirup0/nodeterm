import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * React Flow positions every handle through its side classes
 * (`.react-flow__handle-left/right/top/bottom`), each of which centers the dot on the node edge
 * with `transform: translate(±50%, ±50%)`. Any of OUR handle rules that declares `transform`
 * therefore REPLACES that translate — which is how the bridge handle's hover "scale" shifted the
 * dot half its size away from the cursor (and could push it out from under the pointer,
 * flickering the hover state). Hover feedback on a handle is a box-shadow ring, never a
 * transform. A rule that genuinely needs one opts out with a `handle-transform-exempt:` comment
 * on the line above — restating the full translate chain is then that rule's own job.
 */

// `.replace(/\r\n/g, '\n')` on every read below: a test that reads a checked-in file must not
// care how git checked it out. Git for Windows defaults to `core.autocrlf=true`, so a Windows
// clone has CRLF working files, and a slice on a literal containing `\n` (`indexOf('}\n}')`,
// `indexOf('\n}\n')`) then matches nothing and the assertion fails on a checkout with zero local
// changes (issue #578). `.gitattributes` is the durable half of the fix; this is the half that
// survives a working tree that was checked out before it landed.
const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8').replace(/\r\n/g, '\n')

describe('React Flow handle rules never declare transform', () => {
  it('finds no transform inside a handle-targeting rule block', () => {
    const offenders: string[] = []
    const lines = CSS.split('\n')
    let selector = ''
    let inHandleBlock = false
    lines.forEach((line, i) => {
      if (line.includes('{') && !line.trim().startsWith('@')) {
        selector = line.split('{')[0].trim() || selector
        inHandleBlock = /(^|[.\s,])(react-flow__handle|bridge-handle)/.test(selector)
      }
      if (line.includes('}') && !line.includes('{')) {
        inHandleBlock = false
        return
      }
      if (!inHandleBlock) return
      if (!/^\s*transform\s*:/.test(line)) return
      if (lines[i - 1]?.includes('handle-transform-exempt:')) return
      offenders.push(`${selector} (line ${i + 1}): ${line.trim()}`)
    })
    expect(offenders).toEqual([])
  })
})
