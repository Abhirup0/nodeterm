import { describe, it, expect, vi } from 'vitest'
import { dispatchGlobalKeydown, type GlobalKeydownDeps, type GlobalKeyEvent } from './globalKeybindings'
import { XTERM_INPUT_CLASS } from './keyContext'

const ev = (over: Partial<GlobalKeyEvent>): GlobalKeyEvent => ({
  metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, key: '',
  defaultPrevented: false,
  preventDefault() { this.defaultPrevented = true },
  ...over
})
const noGesture = () => false
const deps = (over: Partial<GlobalKeydownDeps> = {}): GlobalKeydownDeps => ({
  activeElement: () => null,
  kanbanOpen: () => false,
  overrides: () => ({}),
  isMac: true,
  handlers: {},
  gestures: { keyedDictation: noGesture, zoom: noGesture, projectJump: noGesture, copy: noGesture },
  ...over
})

describe('dispatchGlobalKeydown', () => {
  it('bails on defaultPrevented without touching anything', () => {
    const dictation = vi.fn()
    const d = deps({ gestures: { keyedDictation: dictation, zoom: noGesture, projectJump: noGesture, copy: noGesture } })
    expect(dispatchGlobalKeydown(ev({ metaKey: true, key: 'k', defaultPrevented: true }), d)).toBe(false)
    expect(dictation).not.toHaveBeenCalled()
  })
  it('runs a claimed registry handler and preventDefaults', () => {
    const e = ev({ metaKey: true, key: 'k' })
    const palette = vi.fn(() => true)
    expect(dispatchGlobalKeydown(e, deps({ handlers: { 'app.commandPalette': palette } }))).toBe(true)
    expect(e.defaultPrevented).toBe(true)
  })
  it('a declining handler leaves the key alone (falls through to the platform)', () => {
    const e = ev({ metaKey: true, key: 'k' })
    expect(dispatchGlobalKeydown(e, deps({ handlers: { 'app.commandPalette': () => false } }))).toBe(false)
    expect(e.defaultPrevented).toBe(false)
  })
  it('a resolved command with no registered handler is not claimed', () => {
    const e = ev({ metaKey: true, key: 'w' })  // node.close: main-intercepted on desktop, browser-owned in SE
    expect(dispatchGlobalKeydown(e, deps())).toBe(false)
    expect(e.defaultPrevented).toBe(false)
  })
  it('keyed dictation wins over a colliding registry default, but not while typing or in terminal', () => {
    const dictation = vi.fn((e: GlobalKeyEvent) => { e.preventDefault(); return true })
    const term = vi.fn(() => true)
    const g = { keyedDictation: dictation, zoom: noGesture, projectJump: noGesture, copy: noGesture }
    const d = deps({ gestures: g, handlers: { 'node.newTerminal': term } })
    expect(dispatchGlobalKeydown(ev({ metaKey: true, key: 't' }), d)).toBe(true)
    expect(term).not.toHaveBeenCalled()
    const typing = deps({ gestures: g, activeElement: () => ({ tagName: 'INPUT' }) })
    expect(dispatchGlobalKeydown(ev({ metaKey: true, key: 't' }), typing)).toBe(false)
    const terminal = deps({
      gestures: g,
      activeElement: () => ({ tagName: 'TEXTAREA', classList: { contains: (n: string) => n === XTERM_INPUT_CLASS } })
    })
    dispatchGlobalKeydown(ev({ metaKey: true, key: 't' }), terminal)
    expect(dictation).toHaveBeenCalledTimes(1)
  })
  it('typing blocks canvas AND app commands (the announced D-typing guard fix)', () => {
    const palette = vi.fn(() => true)
    const undo = vi.fn(() => true)
    const typing = deps({
      activeElement: () => ({ tagName: 'DIV', isContentEditable: true }),
      handlers: { 'app.commandPalette': palette, 'canvas.undo': undo }
    })
    expect(dispatchGlobalKeydown(ev({ metaKey: true, key: 'z' }), typing)).toBe(false)
    expect(undo).not.toHaveBeenCalled()
    expect(dispatchGlobalKeydown(ev({ metaKey: true, key: 'k' }), typing)).toBe(false)
    expect(palette).not.toHaveBeenCalled()
    // NOTE: app-scope commands lack allowWhileTyping in the registry, so typing blocks them
    // too — that IS the announced D-typing delta (today Cmd+K fires while renaming a node).
  })
  it('kanban keeps app commands live and canvas commands inert', () => {
    const toggle = vi.fn(() => true)
    const undo = vi.fn(() => true)
    const d = deps({ kanbanOpen: () => true, handlers: { 'view.kanbanToggle': toggle, 'canvas.undo': undo } })
    expect(dispatchGlobalKeydown(ev({ metaKey: true, shiftKey: true, key: 'b' }), d)).toBe(true)
    expect(dispatchGlobalKeydown(ev({ metaKey: true, key: 'z' }), d)).toBe(false)
    expect(undo).not.toHaveBeenCalled()
  })
  // The claim protocol's second half: a RESOLVED chord is spent, whoever declined it. The two
  // tests above only prove it is not claimed — with claiming gestures wired in, a fall-through
  // into them would reinterpret the same chord as a zoom/jump/copy.
  it('a resolved command never reaches a gesture, declined or unhandled', () => {
    const claimAll = vi.fn(() => true)
    const g = { keyedDictation: noGesture, zoom: claimAll, projectJump: claimAll, copy: claimAll }
    const declined = ev({ metaKey: true, key: 'k' })
    expect(dispatchGlobalKeydown(declined, deps({ gestures: g, handlers: { 'app.commandPalette': () => false } }))).toBe(false)
    const unhandled = ev({ metaKey: true, key: 'w' })
    expect(dispatchGlobalKeydown(unhandled, deps({ gestures: g }))).toBe(false)
    expect(claimAll).not.toHaveBeenCalled()
  })
  it('gestures run after a registry miss, in zoom → projectJump → copy order', () => {
    const order: string[] = []
    const g = {
      keyedDictation: noGesture,
      zoom: () => { order.push('zoom'); return false },
      projectJump: () => { order.push('jump'); return false },
      copy: () => { order.push('copy'); return false }
    }
    expect(dispatchGlobalKeydown(ev({ key: '!' , shiftKey: true }), deps({ gestures: g }))).toBe(false)
    expect(order).toEqual(['zoom', 'jump', 'copy'])
  })
  it('the kanban board blocks the keyed-dictation gesture entirely', () => {
    // The gate is `!typing && !terminal && !kanbanOpen`. Dropping the kanban half leaves a
    // dictation overlay firing over the board with nothing on screen that asked for it — and
    // the board is exactly where the canvas-only-shortcut discipline says gestures go quiet.
    const dictation = vi.fn(() => true)
    const g = { keyedDictation: dictation, zoom: noGesture, projectJump: noGesture, copy: noGesture }
    const d = deps({ kanbanOpen: () => true, gestures: g })
    expect(dispatchGlobalKeydown(ev({ metaKey: true, altKey: true, key: 'd' }), d)).toBe(false)
    expect(dictation).not.toHaveBeenCalled()
  })
  it('a claiming trailing gesture short-circuits: the later ones never run', () => {
    // The `if (...) return true` chain, not a run-them-all fan-out. Turning any of the three
    // into an unconditional call would let one chord be interpreted twice (zoom AND jump).
    const zoom = vi.fn(() => true)
    const projectJump = vi.fn(() => true)
    const copy = vi.fn(() => true)
    const g = { keyedDictation: noGesture, zoom, projectJump, copy }
    expect(dispatchGlobalKeydown(ev({ shiftKey: true, key: '!' }), deps({ gestures: g }))).toBe(true)
    expect(zoom).toHaveBeenCalledTimes(1)
    expect(projectJump).not.toHaveBeenCalled()
    expect(copy).not.toHaveBeenCalled()
  })
  it('overrides reroute dispatch', () => {
    const fit = vi.fn(() => true)
    const d = deps({
      overrides: () => ({ 'app.commandPalette': [], 'canvas.fitAll': ['Cmd+K'] }),
      handlers: { 'canvas.fitAll': fit }
    })
    expect(dispatchGlobalKeydown(ev({ metaKey: true, key: 'k' }), d)).toBe(true)
    expect(fit).toHaveBeenCalled()
  })
})
