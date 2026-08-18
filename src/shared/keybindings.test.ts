import { describe, it, expect } from 'vitest'
import {
  COMMAND_DEFINITIONS,
  COMMANDS_BY_ID,
  isCommandId,
  normalizeBindingForCommand,
  getEffectiveBindings,
  bindingIdentity,
  findKeybindingConflicts
} from './keybindings'
import { parseShortcut } from './shortcut'

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
