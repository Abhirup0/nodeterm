import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

/**
 * TWO xterm key handlers, one decision function.
 *
 * `TerminalNode` (canvas) and `ModalTerminal` (kanban card modal) both call `terminalKeyAction`
 * and both act on its answer — the modal's own comments call itself a MIRROR of the node's. The
 * decision is shared and tested; the ACTING is duplicated, and that is where it drifts.
 *
 * The uncancelled actions are the fragile half: `bubble` and `native` must return `false` WITHOUT
 * `preventDefault()`, and a call site that knows only `bubble` falls through to the `preventDefault`
 * line — which for `native` is precisely issue #562's bug (Ctrl+V eaten, nothing pasted), except
 * now on one surface only, and the shared unit tests would still be green.
 *
 * Source-level, in the spirit of `hook-verified-parity.test.ts`: the alternative is a full
 * xterm+DOM harness, and vitest here runs in the node environment.
 */
const FILES = [
  'src/renderer/nodes/TerminalNode.tsx',
  'src/renderer/components/kanban/ModalTerminal.tsx'
]

describe('terminal key-handler parity', () => {
  for (const rel of FILES) {
    it(`${rel} returns without preventDefault for both uncancelled actions`, () => {
      const src = readFileSync(join(process.cwd(), rel), 'utf8')
      expect(src).toContain("action === 'bubble' || action === 'native'")
      // …and it does so BEFORE the preventDefault that copy / shift-enter need.
      const guard = src.indexOf("action === 'bubble' || action === 'native'")
      const prevent = src.indexOf('e.preventDefault()', guard)
      expect(guard).toBeGreaterThan(-1)
      expect(prevent).toBeGreaterThan(guard)
    })
  }
})
