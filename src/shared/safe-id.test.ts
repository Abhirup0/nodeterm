import { describe, it, expect } from 'vitest'
import { NODE_ID_MAX, isSafeNodeId } from './safe-id'

describe('isSafeNodeId (shared home)', () => {
  it('refuses dot segments, separators, spaces, empties and over-length ids', () => {
    // The exact corpus node-auth-token.test.ts pins through the re-export, kept here at the
    // definition site so the predicate cannot be weakened without a red test in BOTH places.
    for (const bad of ['..', '.', '../x', 'a b', 'a/b', '', 'x'.repeat(300)]) {
      expect(isSafeNodeId(bad), bad).toBe(false)
    }
  })

  it('accepts every shape the app actually mints', () => {
    for (const good of ['a', 'browser-3', 'p_1.2', 'node-1', 'term_abc.9', 'A.B-C_d']) {
      expect(isSafeNodeId(good), good).toBe(true)
    }
  })

  it('refuses undefined/null and enforces the exact NODE_ID_MAX boundary', () => {
    expect(isSafeNodeId(undefined)).toBe(false)
    expect(isSafeNodeId(null)).toBe(false)
    expect(isSafeNodeId('x'.repeat(NODE_ID_MAX))).toBe(true)
    expect(isSafeNodeId('x'.repeat(NODE_ID_MAX + 1))).toBe(false)
  })

  // The "core re-exports the SAME function object" identity assertion lives in
  // core/remote-safety.test.ts: this file is part of the WEB typecheck program
  // (tsconfig.web.json), which deliberately cannot see src/core — the very layering rule that
  // forced the move. The pin exists; it just sits on the side of the boundary that may import both.
})
