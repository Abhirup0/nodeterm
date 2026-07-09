import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

describe('core boundary', () => {
  it('no file under src/core imports electron', () => {
    const offenders = walk(__dirname).filter((f) =>
      /from ['"]electron['"]|require\(['"]electron['"]\)/.test(fs.readFileSync(f, 'utf8'))
    )
    expect(offenders).toEqual([])
  })
})
