import { describe, it, expect } from 'vitest'
import {
  COMMAND_DEFINITIONS,
  COMMANDS_BY_ID,
  isCommandId,
  normalizeBindingForCommand,
  getEffectiveBindings,
  bindingIdentity,
  findKeybindingConflicts,
  sanitizeKeybindingOverrides,
  resolveCommandForKeyEvent
} from './keybindings'
import { parseShortcut } from './shortcut'
import type { ShortcutKeyEvent } from './shortcut'

describe('registry invariants', () => {
  it('has unique ids and a map that covers them all', () => {
    const ids = COMMAND_DEFINITIONS.map((d) => d.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(COMMANDS_BY_ID.size).toBe(ids.length)
    for (const d of COMMAND_DEFINITIONS) expect(COMMANDS_BY_ID.get(d.id)).toBe(d)
  })

  it('every default binding parses, and keyed defaults carry a key', () => {
    for (const d of COMMAND_DEFINITIONS) {
      for (const s of [...d.defaultBindings.darwin, ...d.defaultBindings.other]) {
        const p = parseShortcut(s)
        if (d.allowHoldChord) continue
        expect(p.key, `${d.id}: ${s}`).not.toBeNull()
      }
    }
  })

  it('pins the defaults that PR 2 will wire (behavior contract)', () => {
    expect(COMMANDS_BY_ID.get('app.commandPalette')?.defaultBindings.darwin).toEqual(['Cmd+K'])
    expect(COMMANDS_BY_ID.get('node.close')?.defaultBindings.other).toEqual(['Cmd+W'])
    expect(COMMANDS_BY_ID.get('canvas.redo')?.defaultBindings.other).toEqual(['Cmd+Shift+Z', 'Cmd+Y'])
    expect(COMMANDS_BY_ID.get('terminal.copySelection')?.defaultBindings.other).toEqual([
      'Cmd+Shift+C', 'Ctrl+Insert'
    ])
    expect(COMMANDS_BY_ID.get('canvas.deleteSelection')?.defaultBindings.other).toEqual(['Delete', 'Backspace'])
    expect(COMMANDS_BY_ID.get('speech.dictation')?.defaultBindings.darwin).toEqual(['Cmd+Alt'])
    expect(COMMANDS_BY_ID.get('canvas.fitAll')?.defaultBindings.darwin).toEqual([])
  })

  it('isCommandId accepts known ids and rejects unknowns', () => {
    expect(isCommandId('node.newTerminal')).toBe(true)
    expect(isCommandId('node.selfDestruct')).toBe(false)
  })
})

const def = (id: string) => {
  const d = COMMANDS_BY_ID.get(id as never)
  if (!d) throw new Error(`missing ${id}`)
  return d
}

describe('normalizeBindingForCommand', () => {
  it('canonicalizes token order and casing', () => {
    const r = normalizeBindingForCommand(def('node.newTerminal'), 'shift+t+cmd', true)
    expect(r).toEqual({ ok: true, value: 'Cmd+Shift+T' })
  })
  it('rejects a chord with no modifier for a normal command', () => {
    const r = normalizeBindingForCommand(def('node.newTerminal'), 'T', true)
    expect(r.ok).toBe(false)
  })
  it('rejects shift-only chords (stealing typed text)', () => {
    expect(normalizeBindingForCommand(def('node.newTerminal'), 'Shift+T', true).ok).toBe(false)
  })
  it('allows safe bare keys only with allowBareKey', () => {
    expect(normalizeBindingForCommand(def('canvas.deleteSelection'), 'Delete', true)).toEqual({
      ok: true, value: 'Delete'
    })
    expect(normalizeBindingForCommand(def('canvas.deleteSelection'), 'X', true).ok).toBe(false)
    expect(normalizeBindingForCommand(def('node.newTerminal'), 'Delete', true).ok).toBe(false)
  })
  it('allows hold chords only with allowHoldChord', () => {
    expect(normalizeBindingForCommand(def('speech.dictation'), 'Cmd+Alt', true)).toEqual({
      ok: true, value: 'Cmd+Alt'
    })
    expect(normalizeBindingForCommand(def('node.newTerminal'), 'Cmd+Alt', true).ok).toBe(false)
  })
  it('rejects Cmd combined with literal Ctrl on non-mac', () => {
    expect(normalizeBindingForCommand(def('node.newTerminal'), 'Cmd+Ctrl+T', false).ok).toBe(false)
    expect(normalizeBindingForCommand(def('node.newTerminal'), 'Cmd+Ctrl+T', true).ok).toBe(true)
  })
  it('rejects garbage', () => {
    expect(normalizeBindingForCommand(def('node.newTerminal'), '', true).ok).toBe(false)
    expect(normalizeBindingForCommand(def('node.newTerminal'), '+++', true).ok).toBe(false)
  })
  it('every default in the registry survives its own validation', () => {
    for (const d of COMMAND_DEFINITIONS) {
      for (const isMac of [true, false]) {
        for (const s of d.defaultBindings[isMac ? 'darwin' : 'other']) {
          const r = normalizeBindingForCommand(d, s, isMac)
          expect(r, `${d.id}: ${s} (isMac=${isMac})`).toEqual({ ok: true, value: s })
        }
      }
    }
  })
})

describe('getEffectiveBindings', () => {
  it('returns platform defaults with no override', () => {
    expect(getEffectiveBindings('terminal.copySelection', {}, true)).toEqual(['Cmd+C'])
    expect(getEffectiveBindings('terminal.copySelection', {}, false)).toEqual([
      'Cmd+Shift+C', 'Ctrl+Insert'
    ])
  })
  it('an override replaces defaults; [] disables', () => {
    const o = { 'node.newTerminal': ['Cmd+Shift+T'], 'canvas.undo': [] as string[] }
    expect(getEffectiveBindings('node.newTerminal', o, true)).toEqual(['Cmd+Shift+T'])
    expect(getEffectiveBindings('canvas.undo', o, true)).toEqual([])
  })
})

describe('bindingIdentity', () => {
  it('resolves Cmd and literal Ctrl to the same identity on non-mac', () => {
    expect(bindingIdentity('Cmd+K', false)).toBe(bindingIdentity('Ctrl+K', false))
  })
  it('keeps them distinct on mac', () => {
    expect(bindingIdentity('Cmd+K', true)).not.toBe(bindingIdentity('Ctrl+K', true))
  })
  it('collapses alias key spellings onto one identity', () => {
    expect(bindingIdentity('Cmd+Esc', true)).toBe(bindingIdentity('Cmd+Escape', true))
    expect(bindingIdentity('Cmd+Return', true)).toBe(bindingIdentity('Cmd+Enter', true))
  })
  it('still separates a modifier from a bare key, and a hold chord from a keyed one', () => {
    expect(bindingIdentity('Cmd+Delete', true)).not.toBe(bindingIdentity('Delete', true))
    expect(bindingIdentity('Cmd+Alt', true)).not.toBe(bindingIdentity('Cmd+Alt+D', true))
  })
})

describe('findKeybindingConflicts', () => {
  it('reports nothing for pure defaults', () => {
    expect(findKeybindingConflicts({}, true)).toEqual([])
    expect(findKeybindingConflicts({}, false)).toEqual([])
  })
  it('the shipped default table is conflict-free even under full scrutiny', () => {
    expect(findKeybindingConflicts({}, true, { includeDefaults: true })).toEqual([])
    expect(findKeybindingConflicts({}, false, { includeDefaults: true })).toEqual([])
  })
  it('flags an override colliding with a default in the same bucket', () => {
    const conflicts = findKeybindingConflicts({ 'canvas.fitAll': ['Cmd+K'] }, true)
    expect(conflicts).toEqual([
      { binding: 'Cmd+K', commandIds: ['app.commandPalette', 'canvas.fitAll'] }
    ])
  })
  it('reports the canonical spelling, not the override as written', () => {
    expect(findKeybindingConflicts({ 'canvas.fitAll': ['cmd+k'] }, true)).toEqual([
      { binding: 'Cmd+K', commandIds: ['app.commandPalette', 'canvas.fitAll'] }
    ])
    // canvas.fitAll precedes node.newTerminal in the registry, so the override is the
    // entry-creating spelling here — the assertion above cannot see the canonicalization.
    expect(findKeybindingConflicts({ 'canvas.fitAll': ['cmd+t'] }, true)).toEqual([
      { binding: 'Cmd+T', commandIds: ['canvas.fitAll', 'node.newTerminal'] }
    ])
  })
  it('flags a cross-spelling collision on non-mac (Ctrl+K vs Cmd+K)', () => {
    const conflicts = findKeybindingConflicts({ 'canvas.fitAll': ['Ctrl+K'] }, false)
    expect(conflicts.map((c) => c.commandIds)).toEqual([['app.commandPalette', 'canvas.fitAll']])
  })
  it('does not flag collisions across buckets', () => {
    // terminal.find is Cmd+F in the terminal bucket; an app-bucket Cmd+F is legal.
    expect(findKeybindingConflicts({ 'canvas.fitAll': ['Cmd+F'] }, true)).toEqual([])
  })
  it('two disabled commands never conflict', () => {
    expect(
      findKeybindingConflicts({ 'canvas.fitAll': [], 'canvas.groupSelection': [] }, true)
    ).toEqual([])
  })
})

describe('sanitizeKeybindingOverrides', () => {
  it('passes through a clean override map', () => {
    const r = sanitizeKeybindingOverrides({ 'node.newTerminal': ['Cmd+Shift+T'] }, true)
    expect(r).toEqual({ overrides: { 'node.newTerminal': ['Cmd+Shift+T'] }, warnings: [] })
  })
  it('canonicalizes spellings', () => {
    const r = sanitizeKeybindingOverrides({ 'node.newTerminal': ['shift+cmd+t'] }, true)
    expect(r.overrides).toEqual({ 'node.newTerminal': ['Cmd+Shift+T'] })
  })
  it('drops unknown ids with a warning, keeps the rest', () => {
    const r = sanitizeKeybindingOverrides(
      { 'node.selfDestruct': ['Cmd+X'], 'canvas.undo': [] }, true
    )
    expect(r.overrides).toEqual({ 'canvas.undo': [] })
    expect(r.warnings.some((w) => w.includes('node.selfDestruct'))).toBe(true)
  })
  it('drops an invalid binding string but keeps valid siblings', () => {
    const r = sanitizeKeybindingOverrides({ 'node.newTerminal': ['Cmd+Shift+T', 'T'] }, true)
    expect(r.overrides).toEqual({ 'node.newTerminal': ['Cmd+Shift+T'] })
    expect(r.warnings.length).toBe(1)
  })
  it('a non-empty list that is entirely invalid falls back to defaults, not disabled', () => {
    const r = sanitizeKeybindingOverrides({ 'node.newTerminal': ['T', '+++'] }, true)
    expect(r.overrides).toEqual({})
    expect(r.warnings.length).toBeGreaterThan(0)
  })
  it('an explicit empty array still means disabled', () => {
    expect(sanitizeKeybindingOverrides({ 'canvas.undo': [] }, true).overrides).toEqual({
      'canvas.undo': []
    })
  })
  it('strips BOTH sides of a conflicting override pair, naming the titles', () => {
    const r = sanitizeKeybindingOverrides(
      { 'canvas.fitAll': ['Cmd+P'], 'canvas.groupSelection': ['Cmd+P'] }, true
    )
    expect(r.overrides).toEqual({})
    expect(r.warnings.some((w) =>
      w.includes('Fit all nodes in view') && w.includes('Group selection')
    )).toBe(true)
  })
  it('an override conflicting with a DEFAULT strips only the override', () => {
    const r = sanitizeKeybindingOverrides({ 'canvas.fitAll': ['Cmd+K'] }, true)
    expect(r.overrides).toEqual({})
    expect(r.warnings.some((w) => w.includes('Command palette'))).toBe(true)
  })
  it('non-object / non-array shapes degrade to empty with a warning', () => {
    expect(sanitizeKeybindingOverrides('nope', true).overrides).toEqual({})
    expect(sanitizeKeybindingOverrides({ 'canvas.undo': 'Cmd+Z' }, true).overrides).toEqual({})
  })
  it('is a fixpoint: sanitizing its own output adds nothing', () => {
    const once = sanitizeKeybindingOverrides(
      { 'canvas.fitAll': ['Cmd+P'], 'node.newTerminal': ['Cmd+Shift+T'] }, true
    )
    const twice = sanitizeKeybindingOverrides(once.overrides, true)
    expect(twice).toEqual({ overrides: once.overrides, warnings: [] })
  })
})

const ev = (over: Partial<ShortcutKeyEvent>): ShortcutKeyEvent => ({
  metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: '', ...over
})
const ctx = (over: Partial<{ typing: boolean; terminal: boolean; kanbanOpen: boolean }> = {}) => ({
  typing: false, terminal: false, kanbanOpen: false, ...over
})

describe('resolveCommandForKeyEvent', () => {
  it('matches a default app chord', () => {
    expect(resolveCommandForKeyEvent(ev({ metaKey: true, key: 'k' }), ctx(), {}, true))
      .toBe('app.commandPalette')
  })
  it('typing blocks commands without allowWhileTyping, allows the flagged ones', () => {
    expect(resolveCommandForKeyEvent(
      ev({ metaKey: true, key: 't' }), ctx({ typing: true }), {}, true
    )).toBeNull()
    expect(resolveCommandForKeyEvent(
      ev({ metaKey: true, key: 'w' }), ctx({ typing: true }), {}, true
    )).toBe('node.close')
  })
  it('terminal focus blocks canvas commands but passes allowInTerminal + terminal scope', () => {
    expect(resolveCommandForKeyEvent(
      ev({ metaKey: true, key: 't' }), ctx({ terminal: true }), {}, true
    )).toBeNull()
    expect(resolveCommandForKeyEvent(
      ev({ metaKey: true, key: 'k' }), ctx({ terminal: true }), {}, true
    )).toBe('app.commandPalette')
    expect(resolveCommandForKeyEvent(
      ev({ metaKey: true, key: 'f' }), ctx({ terminal: true }), {}, true
    )).toBe('terminal.find')
  })
  it('kanban open makes canvas-scope commands inert, app scope still fires', () => {
    expect(resolveCommandForKeyEvent(
      ev({ metaKey: true, key: 'z' }), ctx({ kanbanOpen: true }), {}, true
    )).toBeNull()
    expect(resolveCommandForKeyEvent(
      ev({ metaKey: true, shiftKey: true, key: 'b' }), ctx({ kanbanOpen: true }), {}, true
    )).toBe('view.kanbanToggle')
  })
  it('terminal.find does NOT fire outside terminal focus (scope-gated)', () => {
    expect(resolveCommandForKeyEvent(ev({ metaKey: true, key: 'f' }), ctx(), {}, true)).toBeNull()
  })
  it('respects overrides and disabled commands', () => {
    const o = { 'app.commandPalette': [] as string[], 'canvas.fitAll': ['Cmd+K'] }
    expect(resolveCommandForKeyEvent(ev({ metaKey: true, key: 'k' }), ctx(), o, true))
      .toBe('canvas.fitAll')
  })
  it('never resolves a hold chord', () => {
    expect(resolveCommandForKeyEvent(
      ev({ metaKey: true, altKey: true, key: 'Alt' }), ctx(), {}, true
    )).toBeNull()
  })
  it('never resolves scm-scope commands — they dispatch from their own composer', () => {
    expect(resolveCommandForKeyEvent(ev({ metaKey: true, key: 'Enter' }), ctx(), {}, true))
      .toBeNull()
  })
  it('registry order breaks cross-bucket identity ties deterministically', () => {
    // Cmd+F sits on terminal.find (terminal bucket); an app-bucket override may share it.
    const o = { 'canvas.fitAll': ['Cmd+F'] }
    expect(resolveCommandForKeyEvent(
      ev({ metaKey: true, key: 'f' }), ctx({ terminal: true }), o, true
    )).toBe('terminal.find')
  })
})
