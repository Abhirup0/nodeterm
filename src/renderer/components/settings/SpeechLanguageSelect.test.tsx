// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { SpeechLanguageSelect } from './SpeechLanguageSelect'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

let host: HTMLDivElement
let root: Root

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  root = createRoot(host)
  // jsdom implements neither of these; useMenuFlip observes the menu and the cursor effect
  // scrolls the active row into view. Both are layout niceties, stubbed rather than exercised.
  Element.prototype.scrollIntoView = vi.fn()
  ;(globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
  document.body.innerHTML = ''
})

function render(value: string, onChange = vi.fn()): { onChange: ReturnType<typeof vi.fn> } {
  act(() => root.render(<SpeechLanguageSelect value={value} onChange={onChange} />))
  return { onChange }
}

const trigger = (): HTMLButtonElement =>
  host.querySelector('.speech-lang__trigger') as HTMLButtonElement
const filter = (): HTMLInputElement =>
  document.querySelector('.tab-menu__filter') as HTMLInputElement
const rowLabels = (): string[] =>
  [...document.querySelectorAll('.speech-lang__name')].map((n) => n.textContent ?? '')

function open(): void {
  act(() => trigger().dispatchEvent(new MouseEvent('click', { bubbles: true })))
}
function type(text: string): void {
  const el = filter()
  act(() => {
    // React's onChange rides the native input event; set the value through the descriptor so the
    // synthetic event sees it.
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(el, text)
    el.dispatchEvent(new Event('input', { bubbles: true }))
  })
}
function key(k: string): void {
  act(() => filter().dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true })))
}

describe('SpeechLanguageSelect', () => {
  it('names the current language on the trigger, with its endonym', () => {
    render('pl')
    expect(trigger().textContent).toContain('Polish')
    expect(trigger().textContent).toContain('polski')
  })

  it('shows a stored code it cannot name, instead of rendering blank', () => {
    // The old <select> showed nothing here and the next click overwrote the value (issue #586).
    render('xx-custom')
    expect(trigger().textContent).toContain('xx-custom')
    open()
    expect(rowLabels()).toContain('xx-custom')
  })

  it('finds Polish by its endonym and picks it with Enter', () => {
    const { onChange } = render('auto')
    open()
    type('polski')
    expect(rowLabels()[0]).toBe('Polish')
    key('Enter')
    expect(onChange).toHaveBeenCalledWith('pl')
    // Picking closes the menu.
    expect(document.querySelector('.tab-menu__filter')).toBeNull()
  })

  it('moves the cursor with the arrow keys and wraps at the ends', () => {
    const { onChange } = render('auto')
    open()
    type('pol') // Polish, then Polish's substring matches
    key('ArrowDown')
    key('ArrowUp')
    key('ArrowUp') // wrap to the last row
    const last = rowLabels().at(-1)
    key('Enter')
    expect(onChange).toHaveBeenCalledTimes(1)
    expect(last).toBeDefined()
  })

  it('says so when nothing matches, rather than showing an empty menu', () => {
    render('auto')
    open()
    type('zzzz')
    expect(rowLabels()).toEqual([])
    expect(document.querySelector('.speech-lang__empty')?.textContent).toContain('zzzz')
  })

  it('closes on Escape without changing the value, and keeps it off the Settings dialog', () => {
    const { onChange } = render('auto')
    const seen: KeyboardEvent[] = []
    document.addEventListener('keydown', (e) => seen.push(e as KeyboardEvent))
    open()
    key('Escape')
    expect(document.querySelector('.tab-menu__filter')).toBeNull()
    expect(onChange).not.toHaveBeenCalled()
    // stopPropagation: the dialog's own Escape handler must not also fire and close Settings.
    expect(seen).toHaveLength(0)
  })

  it('closes on a backdrop click', () => {
    render('auto')
    open()
    const backdrop = document.querySelector('.tab-backdrop') as HTMLElement
    act(() => backdrop.dispatchEvent(new MouseEvent('click', { bubbles: true })))
    expect(document.querySelector('.tab-menu__filter')).toBeNull()
  })
})
