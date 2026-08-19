// @vitest-environment jsdom
//
// THE trust gate for a git-shared setup/archive script: a cloned repo's `.nodeterm/settings.json`
// can carry `setupScript: "curl … | sh"`, and this dialog is the only thing between it and a
// spawn. Everything asserted here is security-shaped:
//
//  - it must show EVERYTHING the one approval covers (both family scripts), because main hashes
//    the family together — approving after reading only half is approving code unseen,
//  - only the two buttons are answers: Escape / an overlay misclick submit NOTHING (main's expiry
//    owns the `undefined`), mirroring the capability clone notice's dismiss handling,
//  - exactly ONE `consent` call per request, however many times the button is hit,
//  - `projectName` / `locationLabel` cross the IPC boundary from a file the user did not write:
//    they are rendered as TEXT ONLY and clamped (no control characters, length capped).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import type { ProjectSetupConsentRequest } from '@shared/project-settings'
import { CONFIRM_ARM_MS } from './confirm-key'
import { SETUP_LABEL_MAX, SetupConsentDialog } from './SetupConsentDialog'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const request = (over: Partial<ProjectSetupConsentRequest> = {}): ProjectSetupConsentRequest => ({
  requestId: 'req-1',
  kind: 'setup',
  projectName: 'cloned-repo',
  locationLabel: '~/code/cloned-repo',
  scripts: { setup: 'npm install', archive: 'rm -rf node_modules' },
  previouslyApproved: false,
  ...over
})

let root: Root
let host: HTMLElement
let consent: ReturnType<typeof vi.fn>
let emitRequest: (req: ProjectSetupConsentRequest) => void
let emitDismiss: (p: { requestId: string }) => void
let offRequest: ReturnType<typeof vi.fn>
let offDismiss: ReturnType<typeof vi.fn>

function mount(): void {
  root = createRoot(host)
  act(() => root.render(<SetupConsentDialog />))
}

function dialog(): HTMLElement | null {
  return document.querySelector('.confirm')
}

function text(): string {
  return dialog()?.textContent ?? ''
}

function scripts(): HTMLElement[] {
  return [...document.querySelectorAll<HTMLElement>('.confirm pre[data-script-kind]')]
}

function button(label: string): HTMLButtonElement {
  const el = [...document.querySelectorAll<HTMLButtonElement>('.confirm button')].find(
    (b) => b.textContent === label
  )
  expect(el, `button "${label}"`).toBeTruthy()
  return el!
}

beforeEach(() => {
  host = document.createElement('div')
  document.body.appendChild(host)
  consent = vi.fn(async () => {})
  offRequest = vi.fn()
  offDismiss = vi.fn()
  ;(window as unknown as { nodeTerminal: unknown }).nodeTerminal = {
    projectSetup: {
      consent,
      onConsentRequest: (cb: (r: ProjectSetupConsentRequest) => void) => {
        emitRequest = cb
        return offRequest
      },
      onConsentDismiss: (cb: (p: { requestId: string }) => void) => {
        emitDismiss = cb
        return offDismiss
      }
    }
  }
})

afterEach(() => {
  act(() => root.unmount())
  host.remove()
})

describe('SetupConsentDialog', () => {
  it('renders nothing until a request arrives', () => {
    mount()
    expect(dialog()).toBeNull()
  })

  it('names the project and its location, and shows BOTH family scripts with the running one first', () => {
    mount()
    act(() => emitRequest(request({ kind: 'archive' })))
    expect(text()).toContain('cloned-repo')
    expect(text()).toContain('~/code/cloned-repo')
    const boxes = scripts()
    expect(boxes).toHaveLength(2)
    // One approval covers the whole family, so the dialog shows the whole family — the script
    // about to run leads, but the other is right there and is equally approved.
    expect(boxes[0].dataset.scriptKind).toBe('archive')
    expect(boxes[0].textContent).toBe('rm -rf node_modules')
    expect(boxes[1].dataset.scriptKind).toBe('setup')
    expect(boxes[1].textContent).toBe('npm install')
  })

  it('omits a script the family does not set', () => {
    mount()
    act(() => emitRequest(request({ scripts: { setup: 'make bootstrap' } })))
    const boxes = scripts()
    expect(boxes).toHaveLength(1)
    expect(boxes[0].dataset.scriptKind).toBe('setup')
  })

  it('says the scripts CHANGED when a previous approval exists', () => {
    mount()
    act(() => emitRequest(request({ previouslyApproved: true })))
    expect(text().toLowerCase()).toContain('changed since you approved')
  })

  it('does not say that for a first-time approval', () => {
    mount()
    act(() => emitRequest(request()))
    expect(text().toLowerCase()).not.toContain('changed since you approved')
  })

  it('"Run once" submits approve exactly once, however many clicks land', () => {
    mount()
    act(() => emitRequest(request()))
    const btn = button('Run once')
    act(() => {
      btn.click()
      btn.click()
    })
    expect(consent).toHaveBeenCalledTimes(1)
    expect(consent).toHaveBeenCalledWith('req-1', 'approve')
    expect(dialog()).toBeNull()
  })

  it('"Skip" submits skip', () => {
    mount()
    act(() => emitRequest(request()))
    act(() => button('Skip').click())
    expect(consent).toHaveBeenCalledWith('req-1', 'skip')
    expect(dialog()).toBeNull()
  })

  it('Escape submits NOTHING — it closes the dialog and leaves the answer to main’s expiry', () => {
    mount()
    act(() => emitRequest(request()))
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    })
    expect(dialog()).toBeNull()
    expect(consent).not.toHaveBeenCalled()
  })

  it('an overlay misclick submits NOTHING either', () => {
    mount()
    act(() => emitRequest(request()))
    act(() => {
      document.querySelector<HTMLElement>('.confirm-overlay')!.click()
    })
    expect(dialog()).toBeNull()
    expect(consent).not.toHaveBeenCalled()
  })

  it('is CLICK-ONLY: Enter aimed into the dialog approves nothing', async () => {
    mount()
    act(() => emitRequest(request()))
    // Outwait the arm window first: a fresh dialog ignores Enter for CONFIRM_ARM_MS regardless of
    // `enterConfirms`, so an immediate dispatch would pass even with the prop dropped.
    await new Promise((r) => setTimeout(r, CONFIRM_ARM_MS + 150))
    act(() => {
      dialog()!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }))
    })
    expect(dialog()).toBeTruthy()
    expect(consent).not.toHaveBeenCalled()
  })

  it('holds focus on NO button, so a native Enter/Space mid-typing cannot approve it', () => {
    const typing = document.createElement('input')
    document.body.appendChild(typing)
    typing.focus()
    mount()
    act(() => emitRequest(request()))
    expect(document.activeElement).toBe(typing)
    for (const b of document.querySelectorAll('.confirm button')) {
      expect(document.activeElement).not.toBe(b)
    }
    typing.remove()
  })

  it('the dismiss broadcast drops the local prompt without answering it', () => {
    mount()
    act(() => emitRequest(request()))
    act(() => emitDismiss({ requestId: 'req-1' }))
    expect(dialog()).toBeNull()
    expect(consent).not.toHaveBeenCalled()
  })

  it('a dismiss for some OTHER request leaves this one standing', () => {
    mount()
    act(() => emitRequest(request()))
    act(() => emitDismiss({ requestId: 'req-elsewhere' }))
    expect(dialog()).toBeTruthy()
  })

  it('queues a second request and shows it once the first is answered', () => {
    mount()
    act(() => emitRequest(request()))
    act(() => emitRequest(request({ requestId: 'req-2', projectName: 'other-repo' })))
    expect(text()).toContain('cloned-repo')
    act(() => button('Skip').click())
    expect(dialog()).toBeTruthy()
    expect(text()).toContain('other-repo')
    act(() => button('Run once').click())
    expect(consent).toHaveBeenNthCalledWith(1, 'req-1', 'skip')
    expect(consent).toHaveBeenNthCalledWith(2, 'req-2', 'approve')
  })

  it('a repeated request id does not stack two prompts for the same question', () => {
    mount()
    act(() => emitRequest(request()))
    act(() => emitRequest(request()))
    act(() => button('Skip').click())
    expect(dialog()).toBeNull()
  })

  it('CLAMPS the project name and location: control characters stripped, length capped', () => {
    mount()
    act(() =>
      emitRequest(
        request({
          // Cross-boundary strings out of a file a stranger may have written. The escapes are
          // written as \u sequences on purpose: a raw control byte in a source file is invisible
          // to git and ripgrep, which has already cost this repo a day.
          projectName: 'evil\u001b[31mred\r\nSecond line',
          locationLabel: '/srv/' + 'a'.repeat(400)
        })
      )
    )
    const shown = text()
    // eslint-disable-next-line no-control-regex
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(shown)).toBe(false)
    expect(shown).toContain('evil')
    expect(shown).toContain('Second line')
    // Capped with an ellipsis rather than allowed to run the dialog off the screen.
    expect(shown).not.toContain('a'.repeat(SETUP_LABEL_MAX + 1))
    expect(shown).toContain('\u2026')
  })

  it('renders the script bodies VERBATIM — they are what the approval covers', () => {
    mount()
    act(() => emitRequest(request({ scripts: { setup: 'echo "<img src=x>"\nmake  install' } })))
    // Text, never markup: a `<pre>` child is escaped by React, and the user must see every byte
    // they are approving — clamping a script would mean approving what is not on screen.
    expect(scripts()[0].textContent).toBe('echo "<img src=x>"\nmake  install')
    expect(scripts()[0].querySelector('img')).toBeNull()
  })

  it('unsubscribes both channels on unmount', () => {
    mount()
    act(() => root.unmount())
    expect(offRequest).toHaveBeenCalledTimes(1)
    expect(offDismiss).toHaveBeenCalledTimes(1)
    // The afterEach unmount must stay harmless.
    root = createRoot(host)
  })
})
