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

/** Re-render into the SAME root, so component identity survives a query change — which is the
 *  whole point of the armed-recorder test below. */
function rerender(query: string): void {
  act(() =>
    root!.render(
      <SettingsSearchContext.Provider value={query}>
        <ShortcutsSection isActive={true} />
      </SettingsSearchContext.Provider>
    )
  )
}

function render(query = ''): void {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  rerender(query)
}

const setRecording = (): ReturnType<typeof vi.fn> =>
  (window as unknown as { nodeTerminal: { shortcuts: { setRecording: ReturnType<typeof vi.fn> } } })
    .nodeTerminal.shortcuts.setRecording

/** The section shell's card body — `divide-y [&>*]:py-5`, so every direct child DRAWS. */
const body = (): Element => host.querySelector<HTMLElement>('#shortcuts')!.lastElementChild!

const row = (id: string): HTMLElement => host.querySelector<HTMLElement>(`[data-command="${id}"]`)!
/** The policy row's SegmentedPill, found by the `ariaLabel` it is given (it carries no command id
 *  — it is a setting, not a registry command). */
const pill = (): HTMLElement | null =>
  host.querySelector<HTMLElement>('[role="radiogroup"][aria-label="While a terminal has focus"]')
const pillOption = (label: string): HTMLButtonElement =>
  [...pill()!.querySelectorAll('button')].find((b) => b.textContent === label)!
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
    // Exactly the policy row (its description names Close), the heading and the one command row —
    // no empty siblings.
    expect(pill()).toBeTruthy()
    expect(body().children).toHaveLength(3)
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
    // + 1 for the terminal-policy row, which sits above the groups as its own block.
    expect(body().children).toHaveLength(1 + 6 + COMMAND_DEFINITIONS.length)
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

  // `ShortcutRecorderButton.release` is guarded by `armedRef`, and this section is where that
  // guard is actually reachable: every row is a `SearchableRow`, which returns `null` for a row
  // the query does not match, so typing in the settings search box unmounts a BATCH of recorders
  // at once. The main-process recording bit is ONE global boolean — an unconditional
  // `setRecording(false)` in that cleanup would clear the ARMED recorder's bit from under it and
  // re-arm the ⌘W/⌘M intercepts mid-capture.
  it('keeps the global recording bit while non-armed sibling recorders unmount', () => {
    render()
    click(recorder('terminal.copySelection', 'Record')!)
    expect(setRecording()).toHaveBeenCalledWith(true)

    // 'tmux' matches only Copy terminal selection (via its note) — every other row unmounts, and
    // the armed one keeps its identity (stable group/row keys), so it is still armed.
    rerender('tmux')
    expect([...host.querySelectorAll('[data-command]')].map((el) =>
      el.getAttribute('data-command')
    )).toEqual(['terminal.copySelection'])
    expect(
      recorder('terminal.copySelection', 'Press keys…')?.getAttribute('data-shortcut-recording')
    ).toBe('true')
    expect(setRecording()).not.toHaveBeenCalledWith(false)

    // …and the armed instance still owes the release on its own unmount (Settings closed
    // mid-recording fires no blur), exactly once.
    const r = root!
    root = null
    act(() => r.unmount())
    host.remove()
    expect(setRecording().mock.calls.filter((c) => c[0] === false)).toHaveLength(1)
  })
})

describe('terminal shortcut policy row', () => {
  // `app-first` is the shipped default and the byte-identical-behavior guarantee of the whole
  // policy: a user who never opens this row must see the pre-feature app.
  it('shows app-first checked by default', () => {
    render()
    expect(pillOption('App shortcuts first').getAttribute('aria-checked')).toBe('true')
    expect(pillOption('Terminal first').getAttribute('aria-checked')).toBe('false')
  })

  it('writes the setting when Terminal first is picked', () => {
    render()
    click(pillOption('Terminal first'))
    expect(useSettings.getState().settings.terminalShortcutPolicy).toBe('terminal-first')
    expect(pillOption('Terminal first').getAttribute('aria-checked')).toBe('true')
  })

  // The row is its OWN searchable unit, not part of a group Fragment: a query that matches only
  // its keywords must keep it and drop every command group, heading included.
  it('survives a query that drops every command group', () => {
    render('tui')
    expect(pill()).toBeTruthy()
    expect(host.querySelectorAll('h3')).toHaveLength(0)
    expect(host.querySelectorAll('[data-command]')).toHaveLength(0)
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

  // Dictation is its own conflict bucket (Task 1), so NEITHER of the three gates above can see an
  // overlap with it — the detector is silent by design and the load path deliberately permits one.
  // These two gates are what makes `conflictBucket`'s "the Settings UI REFUSES to create one" true.
  //
  // They are SCOPED, and the four tests below are the discriminating matrix: the keyed gesture is
  // offered only in plain app focus (`globalKeybindings.ts` — `!ctx.typing && !ctx.terminal &&
  // !ctx.kanbanOpen`), so an 'app'/'canvas'-scope command really does lose the chord most of the
  // time, while a 'terminal'/'scm'-scope one NEVER competes with it and must stay bindable.
  it("refuses a canvas-scope command on Dictate's keyed chord, naming Dictate", () => {
    setKb({ 'speech.dictation': ['Cmd+Alt+D'] })
    const r = commitCandidate('canvas.fitAll', 'Cmd+Alt+D', 'replace')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Dictate')
    expect(kb()['canvas.fitAll']).toBeUndefined()
  })

  it("refuses an app-scope command on Dictate's keyed chord, naming Dictate", () => {
    setKb({ 'speech.dictation': ['Cmd+Alt+D'] })
    const r = commitCandidate('panel.explorer', 'Cmd+Alt+D', 'replace')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Dictate')
    expect(kb()['panel.explorer']).toBeUndefined()
  })

  // The other half of the pair, and the one that reds if gate 1 loses its scope check: Find in
  // terminal fires only in terminal focus, where the gesture is not offered at all — so this
  // binding was legal before the branch, works at dispatch, and must stay accepted.
  it("allows a terminal-scope command on Dictate's keyed chord", () => {
    setKb({ 'speech.dictation': ['Cmd+Alt+D'] })
    expect(commitCandidate('terminal.find', 'Cmd+Alt+D', 'replace')).toEqual({ ok: true })
    expect(kb()['terminal.find']).toEqual(['Cmd+Alt+D'])
  })

  it('refuses a keyed Dictate chord that a global-bucket command already holds', () => {
    const r = commitCandidate('speech.dictation', 'Cmd+K', 'replace')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toContain('Command palette')
    expect(kb()['speech.dictation']).toBeUndefined()
  })

  // Gate 2's mirror of the same rule, and it reds if the loop stops skipping the two focused
  // scopes: Find in terminal holds Cmd+F and Commit holds Cmd+Enter, neither of which the keyed
  // gesture could ever take from them.
  it('allows a keyed Dictate chord that only a focused-surface command holds', () => {
    expect(commitCandidate('speech.dictation', 'Cmd+F', 'replace')).toEqual({ ok: true })
    expect(kb()['speech.dictation']).toEqual(['Cmd+F'])
    expect(commitCandidate('speech.dictation', 'Cmd+Enter', 'replace')).toEqual({ ok: true })
    expect(kb()['speech.dictation']).toEqual(['Cmd+Enter'])
  })

  // DOCUMENTATION OF A PROPERTY, not a guard test — stated honestly because both stay GREEN if the
  // dictation gates are deleted outright. Nothing can make them red by deletion: a hold chord's
  // identity ends in `:(hold)` and no keyed identity can equal it, so correct code has no path to
  // a refusal here. What the second one does discriminate is a mutation of `bindingIdentity`
  // itself — drop the key segment and the default `Cmd+Alt` hold chord starts swallowing every
  // Cmd+Alt+<key> candidate.
  it('documents that a HOLD dictation chord cannot trip the overlap gates', () => {
    const r = commitCandidate('speech.dictation', 'Cmd+Ctrl', 'replace')
    expect(r.ok).toBe(true)
  })

  it('documents that the default hold chord blocks no keyed candidate', () => {
    const r = commitCandidate('canvas.fitAll', 'Cmd+Alt+F9', 'replace')
    expect(r.ok).toBe(true)
  })
})
