import { describe, it, expect } from 'vitest'
import {
  hasPermissionMode,
  permissionModeFlag,
  withPermissionMode,
  resolvePermissionMode,
  PERMISSION_MODE_LABELS,
  type AgentPermissionMode
} from './config'

describe('hasPermissionMode', () => {
  it('is claude-only', () => {
    expect(hasPermissionMode('claude')).toBe(true)
    expect(hasPermissionMode('codex')).toBe(false)
    expect(hasPermissionMode('gemini')).toBe(false)
    expect(hasPermissionMode('custom:abc')).toBe(false)
  })
})

describe('permissionModeFlag', () => {
  // Load-bearing: "ask each time" must reproduce today's bare command exactly, so the
  // setting can always be returned to a known-good state.
  it('returns no flags for manual', () => {
    expect(permissionModeFlag('manual')).toEqual([])
  })

  it('returns the CLI flag pair for every other mode', () => {
    expect(permissionModeFlag('auto')).toEqual(['--permission-mode', 'auto'])
    expect(permissionModeFlag('acceptEdits')).toEqual(['--permission-mode', 'acceptEdits'])
    expect(permissionModeFlag('plan')).toEqual(['--permission-mode', 'plan'])
    expect(permissionModeFlag('bypassPermissions')).toEqual([
      '--permission-mode',
      'bypassPermissions'
    ])
  })
})

describe('withPermissionMode', () => {
  it('appends the flag for a capable agent', () => {
    expect(withPermissionMode('claude', 'claude', 'auto')).toBe('claude --permission-mode auto')
  })

  it('leaves the command bare in manual mode', () => {
    expect(withPermissionMode('claude', 'claude', 'manual')).toBe('claude')
  })

  it('appends after existing args (Branch resume)', () => {
    expect(withPermissionMode('claude -r abc123', 'claude', 'auto')).toBe(
      'claude -r abc123 --permission-mode auto'
    )
  })

  it('never touches a non-capable agent', () => {
    expect(withPermissionMode('codex', 'codex', 'auto')).toBe('codex')
    expect(withPermissionMode('my-agent', 'custom:x', 'bypassPermissions')).toBe('my-agent')
  })
})

describe('resolvePermissionMode', () => {
  const settings = { claudePermissionMode: 'auto' as AgentPermissionMode }

  it('falls back to the global when the project has no override', () => {
    expect(resolvePermissionMode({}, settings)).toBe('auto')
    expect(resolvePermissionMode(undefined, settings)).toBe('auto')
  })

  it('lets the project override the global', () => {
    expect(resolvePermissionMode({ defaultPermissionMode: 'plan' }, settings)).toBe('plan')
  })

  it('ignores an unknown persisted value rather than passing it to the CLI', () => {
    const project = { defaultPermissionMode: 'yolo' as unknown as AgentPermissionMode }
    expect(resolvePermissionMode(project, settings)).toBe('auto')
  })

  it('ignores an unknown global value and falls back to auto', () => {
    const bad = { claudePermissionMode: 'yolo' as unknown as AgentPermissionMode }
    expect(resolvePermissionMode({}, bad)).toBe('auto')
  })
})

describe('PERMISSION_MODE_LABELS', () => {
  it('labels every mode', () => {
    expect(PERMISSION_MODE_LABELS.manual).toBe('Ask each time')
    expect(PERMISSION_MODE_LABELS.auto).toBe('Auto')
    expect(PERMISSION_MODE_LABELS.acceptEdits).toBe('Accept edits')
    expect(PERMISSION_MODE_LABELS.plan).toBe('Plan')
    expect(PERMISSION_MODE_LABELS.bypassPermissions).toBe('Bypass all')
  })
})
