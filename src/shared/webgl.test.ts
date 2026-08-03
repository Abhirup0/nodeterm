import { describe, expect, it } from 'vitest'
import { resolveTerminalRenderer } from './webgl'

// The renderer mode is the one thing every terminal on the canvas reads, and its DEFAULT ('auto')
// resolution must not move: every user who never touched the setting is on it.
describe('resolveTerminalRenderer', () => {
  it("'auto' is the DOM renderer on macOS and per-terminal WebGL everywhere else", () => {
    // The pre-existing platform rule, unchanged — see the doc comment for the macOS field reports.
    expect(resolveTerminalRenderer('auto', true)).toBe('dom')
    expect(resolveTerminalRenderer('auto', false)).toBe('webgl')
  })

  it("'on' is per-terminal WebGL on every platform (a deliberate opt-in on macOS)", () => {
    expect(resolveTerminalRenderer('on', true)).toBe('webgl')
    expect(resolveTerminalRenderer('on', false)).toBe('webgl')
  })

  it("'off' is the DOM renderer on every platform", () => {
    expect(resolveTerminalRenderer('off', true)).toBe('dom')
    expect(resolveTerminalRenderer('off', false)).toBe('dom')
  })

  it("'shared' is the shared canvas on every platform — it is the escape from the context cap", () => {
    // Platform-independent by design: the whole point of one context for the whole canvas is that
    // the per-terminal context pressure (the macOS failure mode) does not exist.
    expect(resolveTerminalRenderer('shared', true)).toBe('shared')
    expect(resolveTerminalRenderer('shared', false)).toBe('shared')
  })

  it('resolves legacy booleans and garbage the way the migration would', () => {
    // Settings arrive from a hand-editable JSON file and the store migrates them — but the
    // resolver is also called with whatever is in memory, so it must never answer 'shared' by
    // accident: an unknown value is the DEFAULT, i.e. 'auto'.
    expect(resolveTerminalRenderer(true, false)).toBe('webgl')
    expect(resolveTerminalRenderer(false, false)).toBe('dom')
    expect(resolveTerminalRenderer(undefined, true)).toBe('dom')
    expect(resolveTerminalRenderer(undefined, false)).toBe('webgl')
    expect(resolveTerminalRenderer('warp-speed' as 'auto', true)).toBe('dom')
    expect(resolveTerminalRenderer('warp-speed' as 'auto', false)).toBe('webgl')
  })
})
