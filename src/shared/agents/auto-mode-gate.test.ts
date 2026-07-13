// The `auto` permission mode only exists in Claude Code >= 2.1.71. Older CLIs REJECT it
// (`error: option '--permission-mode <mode>' argument 'auto' is invalid.` → exit 1), which would
// kill every Claude node launch. These tests pin the version predicate + the gate that degrades
// `auto` to the bare command (and nothing else) when the CLI is too old or unknown.
import { describe, it, expect } from 'vitest'
import {
  AUTO_PERMISSION_MODE_MIN_VERSION,
  FULLSCREEN_TUI_MIN_VERSION,
  supportsAutoPermissionMode,
  supportsFullscreenTui,
  gatePermissionMode,
  withPermissionMode,
  ALL_PERMISSION_MODES,
  type AgentPermissionMode
} from './config'

describe('supportsAutoPermissionMode', () => {
  it('accepts the first version that knows `auto` and everything above it', () => {
    expect(AUTO_PERMISSION_MODE_MIN_VERSION).toBe('2.1.71')
    expect(supportsAutoPermissionMode('2.1.71')).toBe(true)
    expect(supportsAutoPermissionMode('2.1.72')).toBe(true)
    expect(supportsAutoPermissionMode('2.1.207')).toBe(true)
    expect(supportsAutoPermissionMode('2.2.0')).toBe(true)
    expect(supportsAutoPermissionMode('3.0.0')).toBe(true)
  })

  it('rejects the versions that reject the flag value', () => {
    expect(supportsAutoPermissionMode('2.1.50')).toBe(false)
    // 2.1.70 is the last version confirmed to reject `auto`; 2.1.71 is the measured boundary.
    expect(supportsAutoPermissionMode('2.1.70')).toBe(false)
    expect(supportsAutoPermissionMode('2.0.99')).toBe(false)
    expect(supportsAutoPermissionMode('1.9.999')).toBe(false)
  })

  it('reads the real `claude --version` output shape', () => {
    expect(supportsAutoPermissionMode('2.1.207 (Claude Code)')).toBe(true)
    expect(supportsAutoPermissionMode('2.1.70 (Claude Code)\n')).toBe(false)
  })

  it('fails open (unsupported) on anything it cannot read', () => {
    expect(supportsAutoPermissionMode('')).toBe(false)
    expect(supportsAutoPermissionMode(null)).toBe(false)
    expect(supportsAutoPermissionMode(undefined)).toBe(false)
    expect(supportsAutoPermissionMode('command not found')).toBe(false)
    // A two-segment version can't be compared against a patch floor — treat as unknown.
    expect(supportsAutoPermissionMode('2.1')).toBe(false)
  })

  it('does not confuse a longer number that merely starts with a supported prefix', () => {
    expect(supportsAutoPermissionMode('12.1.90')).toBe(true)
    expect(supportsAutoPermissionMode('0.2.99')).toBe(false)
  })
})

describe('supportsFullscreenTui', () => {
  it('accepts the first version that understands the tui setting and everything above it', () => {
    expect(FULLSCREEN_TUI_MIN_VERSION).toBe('2.1.89')
    expect(supportsFullscreenTui('2.1.89')).toBe(true)
    expect(supportsFullscreenTui('2.1.90')).toBe(true)
    expect(supportsFullscreenTui('2.2.0')).toBe(true)
    expect(supportsFullscreenTui('3.0.0')).toBe(true)
    expect(supportsFullscreenTui('2.1.207 (Claude Code)')).toBe(true)
  })

  it('rejects versions below the 2.1.89 floor', () => {
    expect(supportsFullscreenTui('2.1.88')).toBe(false)
    expect(supportsFullscreenTui('2.1.71')).toBe(false)
    expect(supportsFullscreenTui('2.0.99')).toBe(false)
    expect(supportsFullscreenTui('1.9.999')).toBe(false)
  })

  it('fails open (no write) on anything it cannot read', () => {
    expect(supportsFullscreenTui('')).toBe(false)
    expect(supportsFullscreenTui(null)).toBe(false)
    expect(supportsFullscreenTui(undefined)).toBe(false)
    expect(supportsFullscreenTui('command not found')).toBe(false)
    expect(supportsFullscreenTui('2.1')).toBe(false)
  })
})

describe('gatePermissionMode', () => {
  it('degrades auto to manual (= no flag, bare command) when the CLI is too old', () => {
    expect(gatePermissionMode('auto', false)).toBe('manual')
    expect(withPermissionMode('claude', 'claude', gatePermissionMode('auto', false))).toBe('claude')
  })

  it('keeps auto when the CLI supports it', () => {
    expect(gatePermissionMode('auto', true)).toBe('auto')
    expect(withPermissionMode('claude', 'claude', gatePermissionMode('auto', true))).toBe(
      'claude --permission-mode auto'
    )
  })

  it('leaves every other mode alone regardless of the probe', () => {
    // Only `auto` is version-gated: the other four are accepted by every CLI we support, so a
    // failed/never-run probe must not silently strip them.
    for (const mode of ALL_PERMISSION_MODES.filter((m) => m !== 'auto')) {
      expect(gatePermissionMode(mode, false)).toBe(mode)
      expect(gatePermissionMode(mode, true)).toBe(mode)
    }
    expect(withPermissionMode('claude', 'claude', gatePermissionMode('plan', false))).toBe(
      'claude --permission-mode plan'
    )
    expect(withPermissionMode('claude', 'claude', gatePermissionMode('bypassPermissions', false))).toBe(
      'claude --permission-mode bypassPermissions'
    )
  })

  it('never throws on a forged mode (it just stays unrecognized → bare command)', () => {
    const forged = 'auto; rm -rf /' as unknown as AgentPermissionMode
    expect(withPermissionMode('claude', 'claude', gatePermissionMode(forged, true))).toBe('claude')
  })
})
