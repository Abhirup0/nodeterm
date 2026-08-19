// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { COMMAND_DEFINITIONS } from '@shared/keybindings'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useSettings } from '../../../state/settings'
import { SettingsSearchContext } from '../context'
import { ShortcutsSection, commitCandidate } from './ShortcutsSection'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// jsdom reports a non-mac platform; the chips and the refusal messages are platform-formatted,
// so pin macOS here — `isMacPlatform()` is read at call time, never captured at module load.
Object.defineProperty(window.navigator, 'platform', { value: 'MacIntel', configurable: true })

const setKb = (kb: unknown): void =>
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS, keybindings: kb as never } })

const kb = (): Record<string, readonly string[]> =>
  (useSettings.getState().settings.keybindings ?? {}) as Record<string, readonly string[]>

let host: HTMLDivElement
let root: Root | null = null

function render(query = ''): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  act(() =>
    root!.render(
      <SettingsSearchContext.Provider value={query}>
        <ShortcutsSection isActive={true} />
      </SettingsSearchContext.Provider>
    )
  )
}

/** The section shell's card body — `divide-y [&>*]:py-5`, so every direct child DRAWS. */
const body = (): Element => host.querySelector<HTMLElement>('#shortcuts')!.lastElementChild!

const row = (id: string): HTMLElement => host.querySelector<HTMLElement>(`[data-command="${id}"]`)!
const button = (id: string, label: string): HTMLButtonElement | null =>
  row(id).querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)
/** The recorder button carries no per-command aria-label (it is a shared component), so it is
 *  found by its idle text within the row. */
const recorder = (id: string, text: string): HTMLButtonElement | undefined =>
  [...row(id).querySelectorAll('button')].find((b) => b.textContent === text)
const click = (el: HTMLElement): void => {
  act(() => el.dispatchEvent(new MouseEvent('click', { bubbles: true })))
}

beforeEach(() => {
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    settings: { save: vi.fn() },
    shortcuts: { setRecording: vi.fn() }
  }
  setKb(undefined)
})

afterEach(() => {
  if (!root) return
  const r = root
  root = null
  act(() => r.unmount())
  host.remove()
})

describe('ShortcutsSection rows', () => {
  it('renders one row per command, in registry order, with its chips', () => {
    render()
    const ids = [...host.querySelectorAll('[data-command]')].map((el) =>
      el.getAttribute('data-command')
    )
    expect(ids).toEqual(COMMAND_DEFINITIONS.map((d) => d.id))
    const palette = row('app.commandPalette')
    expect(palette.textContent).toContain('Command palette')
    expect([...palette.querySelectorAll('kbd')].map((k) => k.textContent)).toEqual(['⌘', 'K'])
  })

  it('shows an em-dash placeholder and a record button for an unbound command', () => {
    render()
    const fitAll = row('canvas.fitAll')
    expect(fitAll.querySelectorAll('kbd')).toHaveLength(0)
    expect(fitAll.textContent).toContain('—')
    expect(recorder('canvas.fitAll', 'Record shortcut')).toBeTruthy()
    // Nothing to add to, disable, or reset yet.
    expect(recorder('canvas.fitAll', 'Add')).toBeUndefined()
    expect(button('canvas.fitAll', 'Disable Fit all nodes in view')).toBeNull()
    expect(button('canvas.fitAll', 'Reset Fit all nodes in view')).toBeNull()
  })

  it('Disable writes an empty list through the override write path', () => {
    render()
    click(button('app.commandPalette', 'Disable Command palette')!)
    expect(kb()['app.commandPalette']).toEqual([])
    expect(row('app.commandPalette').textContent).toContain('Disabled')
  })

  it('Reset appears only with an override, and deletes the key', () => {
    render()
    expect(button('canvas.undo', 'Reset Undo')).toBeNull()
    click(button('canvas.undo', 'Disable Undo')!)
    expect(kb()['canvas.undo']).toEqual([])
    click(button('canvas.undo', 'Reset Undo')!)
    expect('canvas.undo' in kb()).toBe(false)
    expect([...row('canvas.undo').querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
      '⌘',
      'Z'
    ])
  })

  // A filtered query must not leave the group's padded, divider-separated strip behind: the shell
  // body is `divide-y [&>*]:py-5`, so an empty wrapper is a visible empty block, not nothing.
  it('drops a whole group when neither its header nor any of its rows match', () => {
    render('close')
    expect([...host.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Nodes'])
    expect([...host.querySelectorAll('[data-command]')].map((el) =>
      el.getAttribute('data-command')
    )).toEqual(['node.close'])
    // Exactly the heading and the one row — no empty siblings.
    expect(body().children).toHaveLength(2)
    expect([...body().children].every((c) => (c.textContent ?? '').trim() !== '')).toBe(true)
  })

  // A row can match on its own note, which the group's keywords do not carry — the heading must
  // follow the rows, never filter itself independently and strand one.
  it('keeps the heading over a row that matched on its note', () => {
    render('tmux')
    expect([...host.querySelectorAll('h3')].map((h) => h.textContent)).toEqual(['Terminal'])
    expect([...host.querySelectorAll('[data-command]')].map((el) =>
      el.getAttribute('data-command')
    )).toEqual(['terminal.copySelection'])
  })

  it('renders every group and row unfiltered, each as its own divided block', () => {
    render()
    expect(host.querySelectorAll('h3')).toHaveLength(6)
    expect(body().children).toHaveLength(6 + COMMAND_DEFINITIONS.length)
  })

  // The dictation row must not promise a second chord: every consumer reads
  // `dictationBinding()` = the FIRST effective binding, so an added one could never fire.
  it('offers Add for an ordinary command but never for Dictate', () => {
    setKb({ 'speech.dictation': ['Cmd+Alt', 'Cmd+Alt+D'] })
    render()
    expect(recorder('app.commandPalette', 'Add')).toBeTruthy()
    expect(recorder('speech.dictation', 'Add')).toBeUndefined()
    // …and the chips show only the chord that is actually live.
    expect([...row('speech.dictation').querySelectorAll('kbd')].map((k) => k.textContent)).toEqual([
      '⌘',
      '⌥'
    ])
  })

  // Ruling 1(a): the disabled-dictation render case. `[]` is the load-bearing "off" value —
  // `dictationBinding()` returns '' for it, and this row must SAY so rather than looking unbound.
  it('renders the dictation row as disabled when its override is []', () => {
    setKb({ 'speech.dictation': [] })
    render()
    const dictate = row('speech.dictation')
    expect(dictate.querySelectorAll('kbd')).toHaveLength(0)
    expect(dictate.textContent).toContain('Disabled')
    expect(dictate.textContent).toContain('hold to talk')
  })
})

describe('commitCandidate', () => {
  it('refuses a conflicting candidate, naming the other command, and writes nothing', () => {
    setKb({ 'canvas.fitAll': [] })
    const r = commitCandidate('canvas.fitAll', 'Cmd+K', 'replace')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('Command palette')
    expect(kb()['canvas.fitAll']).toEqual([])
  })

  it('refuses a candidate that would be swallowed app-wide before another surface', () => {
    const r = commitCandidate('node.close', 'Cmd+F', 'replace')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('swallowed app-wide')
    expect(r.ok === false && r.error).toContain('Find in terminal')
    expect('node.close' in kb()).toBe(false)
  })

  // Ruling 2: the two detectors can both see a same-bucket collision for a main-intercepted
  // command. One candidate, ONE message — the conflict message, not both.
  it('reports a same-bucket collision on an intercepted command exactly once', () => {
    const r = commitCandidate('node.close', 'Cmd+K', 'replace')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('Command palette')
    expect(r.ok === false && r.error).not.toContain('swallowed app-wide')
  })

  // REVERSE shadowing: neither existing gate can see it — the shadow check answers only for an
  // intercepted id, and the two commands are in different buckets so nothing conflicts.
  it('refuses a chord the main process intercepts for another command', () => {
    const r = commitCandidate('terminal.find', 'Cmd+W', 'replace')
    expect(r.ok).toBe(false)
    expect(r.ok === false && r.error).toContain('Close node / window')
    expect(r.ok === false && r.error).toContain('Find in terminal')
    expect('terminal.find' in kb()).toBe(false)
  })

  it('still accepts a chord no intercepted command holds', () => {
    expect(commitCandidate('terminal.find', 'Cmd+Alt+F', 'replace')).toEqual({ ok: true })
    expect(kb()['terminal.find']).toEqual(['Cmd+Alt+F'])
  })

  it('accepts a free chord, replacing or adding to the list', () => {
    expect(commitCandidate('canvas.fitAll', 'Cmd+Alt+F', 'replace')).toEqual({ ok: true })
    expect(kb()['canvas.fitAll']).toEqual(['Cmd+Alt+F'])
    expect(commitCandidate('canvas.fitAll', 'Cmd+Alt+G', 'add')).toEqual({ ok: true })
    expect(kb()['canvas.fitAll']).toEqual(['Cmd+Alt+F', 'Cmd+Alt+G'])
    // Re-adding an existing chord is idempotent, not a self-conflict.
    expect(commitCandidate('canvas.fitAll', 'Cmd+Alt+F', 'add')).toEqual({ ok: true })
    expect(kb()['canvas.fitAll']).toEqual(['Cmd+Alt+G', 'Cmd+Alt+F'])
  })
})
