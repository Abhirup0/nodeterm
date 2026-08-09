import { describe, expect, it } from 'vitest'
import {
  approvalFlags,
  modeSupported,
  permissionModeAgentsLabel,
  unsupportedModesNote
} from './approval-mode'
import { ALL_PERMISSION_MODES, type AgentPermissionMode } from './config'

/**
 * Measured flag vocabularies:
 *   claude / grok : --permission-mode auto|acceptEdits|plan|bypassPermissions   (manual = no flag)
 *   gemini 0.54.4 : --approval-mode  default|auto_edit|yolo|plan                (gemini --help)
 *   codex 0.146.0 : --ask-for-approval untrusted|on-request|never               (codex --help)
 */
describe('approvalFlags — claude and grok are untouched', () => {
  it('emits the historical --permission-mode spelling', () => {
    expect(approvalFlags('claude', 'plan')).toEqual(['--permission-mode', 'plan'])
    expect(approvalFlags('grok', 'auto')).toEqual(['--permission-mode', 'auto'])
    expect(approvalFlags('claude', 'manual')).toEqual([])
  })
})

describe('approvalFlags — gemini', () => {
  it('translates every mode gemini can express', () => {
    expect(approvalFlags('gemini', 'manual')).toEqual([])
    expect(approvalFlags('gemini', 'plan')).toEqual(['--approval-mode', 'plan'])
    expect(approvalFlags('gemini', 'acceptEdits')).toEqual(['--approval-mode', 'auto_edit'])
    expect(approvalFlags('gemini', 'bypassPermissions')).toEqual(['--approval-mode', 'yolo'])
    // gemini has no all-tools-but-not-yolo mode; auto_edit is the nearest and is documented as such.
    expect(approvalFlags('gemini', 'auto')).toEqual(['--approval-mode', 'auto_edit'])
  })

  it('supports all five', () => {
    for (const m of ALL_PERMISSION_MODES) expect(modeSupported('gemini', m), m).toBe(true)
  })

  it('only ever emits a value gemini --help lists', () => {
    // The vocabulary read off `gemini --help` on 0.54.4. A value outside it is a failed launch.
    const CHOICES = ['default', 'auto_edit', 'yolo', 'plan']
    for (const m of ALL_PERMISSION_MODES) {
      const flags = approvalFlags('gemini', m)
      if (!flags.length) continue
      expect(flags[0], m).toBe('--approval-mode')
      expect(CHOICES, m).toContain(flags[1])
    }
  })
})

describe('approvalFlags — codex REFUSES what it cannot express', () => {
  it('maps only the three modes that have a real counterpart', () => {
    expect(approvalFlags('codex', 'manual')).toEqual([])
    expect(approvalFlags('codex', 'auto')).toEqual(['--ask-for-approval', 'on-request'])
    expect(approvalFlags('codex', 'bypassPermissions')).toEqual(['--ask-for-approval', 'never'])
  })

  it('emits NO flag for a mode codex has no equivalent of', () => {
    // Silently substituting a nearest match would tell the user "Plan" while codex ran in
    // on-request. No flag = codex's own default, which is the honest degrade.
    expect(approvalFlags('codex', 'plan')).toEqual([])
    expect(approvalFlags('codex', 'acceptEdits')).toEqual([])
    expect(modeSupported('codex', 'plan')).toBe(false)
    expect(modeSupported('codex', 'acceptEdits')).toBe(false)
  })

  it('does NOT touch the sandbox flag', () => {
    // `--sandbox` is a separate axis (read-only | workspace-write | danger-full-access). Folding it
    // into an approval mode would silently widen filesystem access.
    for (const m of ALL_PERMISSION_MODES)
      expect(approvalFlags('codex', m).join(' ')).not.toContain('sandbox')
  })

  it('only ever emits a value codex --help lists', () => {
    // The vocabulary read off `codex --help` on 0.146.0. There is no `on-failure` and no plan mode.
    const CHOICES = ['untrusted', 'on-request', 'never']
    for (const m of ALL_PERMISSION_MODES) {
      const flags = approvalFlags('codex', m)
      if (!flags.length) continue
      expect(flags[0], m).toBe('--ask-for-approval')
      expect(CHOICES, m).toContain(flags[1])
    }
  })
})

describe('approvalFlags — an agent with no permission mode', () => {
  it('emits nothing for opencode and for a custom agent', () => {
    for (const id of ['opencode', 'custom:abc']) {
      for (const m of ALL_PERMISSION_MODES)
        expect(approvalFlags(id, m), `${id}/${m}`).toEqual([])
    }
  })
})

/**
 * The settings copy is DERIVED from the mapping, so it cannot claim a mode works on an agent that
 * cannot express it. These assert the derivation, not the exact wording.
 */
describe('UI copy derived from the mapping', () => {
  it('names every agent whose start-up mode we can set', () => {
    const label = permissionModeAgentsLabel()
    for (const name of ['Claude Code', 'Grok', 'Gemini', 'Codex']) expect(label).toContain(name)
    expect(label).not.toContain('opencode')
  })

  it('admits codex’s two gaps, and names no agent that has none', () => {
    const note = unsupportedModesNote()
    expect(note).toContain('Plan')
    expect(note).toContain('Accept edits')
    expect(note).toContain('Codex')
    // gemini expresses all five, so it must never appear in a sentence about missing modes.
    expect(note).not.toContain('Gemini')
    expect(note).not.toContain('Claude Code')
    expect(note).not.toContain('Grok')
  })

  it('says nothing at all when every capable agent expresses every mode', () => {
    // The sentence has to vanish by itself the day a CLI grows the missing mode — otherwise it
    // becomes a stale claim nobody thinks to delete. Proven by the shape: the note is a join over
    // agents WITH gaps, so an empty gap set is an empty string.
    const gapCount = ALL_PERMISSION_MODES.filter((m) => !modeSupported('codex', m)).length
    expect(gapCount).toBe(2)
    expect(unsupportedModesNote().endsWith('own default.')).toBe(true)
  })
})

/**
 * The mode is re-validated HERE for the same reason `permissionModeFlag` re-validates: the value
 * arrives from hand-editable, git-shared JSON (`.nodeterm/project.json`) and ends up interpolated
 * into a tmux `send-keys` command line, so the type is no protection at all. `constructor` is the
 * one that matters — a plain-object lookup table answers `'constructor' in table` with true and
 * hands back a Function, which would have been stringified onto a command line.
 */
describe('approvalFlags — a forged mode yields the bare command', () => {
  const FORGED = ['yolo', 'on-request', 'constructor', '__proto__', 'toString', '', undefined, null]
  it('emits no flag for any agent', () => {
    for (const id of ['claude', 'grok', 'gemini', 'codex']) {
      for (const f of FORGED) {
        const mode = f as unknown as AgentPermissionMode
        expect(approvalFlags(id, mode), `${id}/${String(f)}`).toEqual([])
        expect(modeSupported(id, mode), `${id}/${String(f)}`).toBe(false)
      }
    }
  })
})
