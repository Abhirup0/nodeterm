import { describe, it, expect } from 'vitest'
import fs from 'fs'
import path from 'path'

function walk(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name)
    return e.isDirectory() ? walk(p) : p.endsWith('.ts') ? [p] : []
  })
}

// Catches: bare `electron`, electron subpaths (`electron/main`), and any reach-back
// into the Electron shell (`../main/`, `../../main/`) — via import or require.
const OFFENDERS =
  /from ['"]electron(\/[^'"]*)?['"]|require\(['"]electron(\/[^'"]*)?['"]\)|from ['"](\.\.\/)+main\//

describe('core boundary', () => {
  it('no file under src/core imports electron or reaches back into ../main', () => {
    const offenders = walk(__dirname)
      // This test file itself contains sample offender strings (below) to prove the regex.
      .filter((f) => f !== __filename)
      .filter((f) => OFFENDERS.test(fs.readFileSync(f, 'utf8')))
    expect(offenders).toEqual([])
  })

  it('offenders regex catches electron, electron subpaths, and ../main reach-backs', () => {
    // These must all be flagged:
    for (const bad of [
      `import { app } from 'electron'`,
      `import { BrowserWindow } from "electron"`,
      `const { ipcMain } = require('electron')`,
      `import { x } from 'electron/main'`,
      `const y = require("electron/common")`,
      `import { PtyManager } from '../main/pty-manager'`,
      `import { z } from '../../main/index'`
    ]) {
      expect(OFFENDERS.test(bad), bad).toBe(true)
    }
    // These must NOT be flagged (legitimate core imports):
    for (const ok of [
      `import fs from 'fs'`,
      `import { CorePlatform } from './platform'`,
      `import { foo } from '../core/foo'`,
      `import { bar } from '@shared/ipc'`,
      `import electronBuilder from 'electron-builder'`
    ]) {
      expect(OFFENDERS.test(ok), ok).toBe(false)
    }
  })
})
