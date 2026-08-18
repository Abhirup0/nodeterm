import { describe, it, expect } from 'vitest'
import { COMMAND_DEFINITIONS, COMMANDS_BY_ID, isCommandId } from './keybindings'
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
    expect(COMMANDS_BY_ID.get('speech.dictation')?.defaultBindings.darwin).toEqual(['Cmd+Alt'])
    expect(COMMANDS_BY_ID.get('canvas.fitAll')?.defaultBindings.darwin).toEqual([])
  })

  it('isCommandId accepts known ids and rejects unknowns', () => {
    expect(isCommandId('node.newTerminal')).toBe(true)
    expect(isCommandId('node.selfDestruct')).toBe(false)
  })
})
