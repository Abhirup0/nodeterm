import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const CSS = readFileSync(join(__dirname, 'styles.css'), 'utf8')

function ruleBody(selector: string): string {
  for (const chunk of CSS.split('}')) {
    const brace = chunk.indexOf('{')
    if (brace < 0) continue
    const head = chunk
      .slice(0, brace)
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .trim()
    if (head === selector) return chunk.slice(brace + 1)
  }
  throw new Error(`no rule for ${selector}`)
}

describe('tab bar New-project pin', () => {
  it('lets the tab pill shrink so the + stays in the window', () => {
    // Without min-width:0 the flex item won't shrink below its tab content, so the +
    // (now a sibling) is shoved off the right edge — the same bug at a different layer.
    expect(ruleBody('.tabbar__projects')).toMatch(/min-width:\s*0/)
    expect(ruleBody('.tabbar__tabs')).toMatch(/min-width:\s*0/)
    expect(ruleBody('.tab__add')).toMatch(/flex-shrink:\s*0/)
  })
})
