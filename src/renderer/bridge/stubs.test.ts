import { describe, it, expect, vi, afterEach } from 'vitest'
import { buildStubApi, unsupported } from './stubs'
import { E_UNSUPPORTED } from '../../shared/rpc'

describe('bridge stubs', () => {
  it('unsupported rejects with a coded error', async () => {
    await expect(unsupported('x.y')).rejects.toMatchObject({ code: E_UNSUPPORTED })
  })

  it('every boot-path subscription returns a working unsubscribe', () => {
    const s = buildStubApi()
    for (const un of [
      s.license.onChange(() => {}),
      s.onCloseNode(() => {}),
      s.onFocusNode(() => {}),
      s.browser.onBrowserNewWindow(() => {}),
      s.onAgentControl(() => {}),
      s.sshProject.onStatus(() => {}),
      s.usage.onUpdate(() => {}),
      s.updates.onAvailable(() => {}),
      s.updates.onProgress(() => {}),
      s.updates.onDownloaded(() => {}),
      s.updates.onNotAvailable(() => {}),
      s.updates.onError(() => {}),
      s.onMarkdownToggle(() => {})
    ]) {
      expect(typeof un).toBe('function')
      expect(() => un()).not.toThrow()
    }
  })

  it('boot-path promise members resolve benignly', async () => {
    const s = buildStubApi()
    await expect(s.announcements.fetch()).resolves.toEqual([])
    await expect(s.updates.getPolicy()).resolves.toBeNull()
    await expect(s.usage.fetch()).resolves.toBeNull()
    await expect(s.userDataDir()).resolves.toBe('')
    await expect(s.license.getStatus()).rejects.toMatchObject({ code: E_UNSUPPORTED })
  })

  it('shell.openExternal opens a new browser tab; reveal/openPath are documented no-ops', () => {
    const s = buildStubApi()
    const open = vi.fn(() => null)
    vi.stubGlobal('window', { open })
    s.shell.openExternal('https://example.com')
    expect(open).toHaveBeenCalledWith('https://example.com', '_blank', 'noopener')
    expect(() => {
      s.shell.reveal('/x')
      s.shell.openPath('/x')
    }).not.toThrow()
    vi.unstubAllGlobals()
  })

  it('void members are safe no-ops', () => {
    const s = buildStubApi()
    expect(() => {
      s.setBadgeCount(3)
      s.contextLink.setLinks({} as never)
      s.sendAgentControlResult({} as never)
    }).not.toThrow()
  })
})

/** A minimal `document` for the hidden-textarea copy fallback: vitest runs in the node
 *  environment, so there is no DOM to lean on. `execCommand` is the knob each test turns.
 *  It models the two things reality has and a naive fake does not: `select()` MOVES FOCUS
 *  (activeElement becomes the scratch textarea), and `execCommand` may THROW (Firefox has
 *  historically thrown NS_ERROR_FAILURE) — the two gaps that hid the leak/focus bugs. */
function fakeDocument(execCommand: () => boolean) {
  // The element that had focus before the copy — xterm's helper textarea, in reality.
  const previouslyFocused = { focus: vi.fn() }
  const doc = {
    activeElement: previouslyFocused as unknown as { focus: () => void },
    createElement: vi.fn(() => textarea),
    body: { appendChild: vi.fn(), removeChild: vi.fn() },
    execCommand: vi.fn(execCommand)
  }
  const textarea = {
    value: '',
    style: {} as Record<string, string>,
    setAttribute: vi.fn(),
    // select() focuses the scratch textarea, exactly as in a real browser
    select: vi.fn(() => {
      doc.activeElement = textarea as unknown as { focus: () => void }
    }),
    focus: vi.fn(),
    remove: vi.fn()
  }
  return { doc, textarea, previouslyFocused }
}

describe('bridge clipboard', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('uses the Clipboard API when it is available', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    buildStubApi().clipboard.writeText('hi')
    expect(writeText).toHaveBeenCalledWith('hi')
  })

  it('falls back to execCommand when there is no Clipboard API (plain http)', () => {
    const { doc, textarea } = fakeDocument(() => true)
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', doc)
    buildStubApi().clipboard.writeText('hi')
    expect(doc.execCommand).toHaveBeenCalledWith('copy')
    expect(textarea.value).toBe('hi')
    // the scratch textarea must not be left behind in the DOM
    expect(textarea.remove).toHaveBeenCalled()
  })

  it('removes the scratch textarea even when execCommand THROWS (no leaked node)', () => {
    const { doc, textarea } = fakeDocument(() => {
      throw new Error('NS_ERROR_FAILURE')
    })
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), isSecureContext: false })
    expect(() => buildStubApi().clipboard.writeText('hi')).not.toThrow()
    // an invisible, focused, position:fixed textarea left in <body> would eat every keystroke
    expect(textarea.remove).toHaveBeenCalled()
  })

  it('restores focus to the previously-focused element after a successful fallback copy', () => {
    const { doc, previouslyFocused } = fakeDocument(() => true)
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', doc)
    buildStubApi().clipboard.writeText('hi')
    // without this the terminal goes deaf: activeElement falls back to <body>
    expect(previouslyFocused.focus).toHaveBeenCalledTimes(1)
  })

  it('restores focus even when the copy fails', () => {
    const { doc, previouslyFocused } = fakeDocument(() => {
      throw new Error('NS_ERROR_FAILURE')
    })
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', { dispatchEvent: vi.fn(), isSecureContext: false })
    buildStubApi().clipboard.writeText('hi')
    expect(previouslyFocused.focus).toHaveBeenCalledTimes(1)
  })

  it('surfaces a toast when even execCommand cannot copy (never silent)', () => {
    const { doc } = fakeDocument(() => false)
    const dispatchEvent = vi.fn()
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', { dispatchEvent, isSecureContext: false })
    buildStubApi().clipboard.writeText('hi')
    expect(dispatchEvent).toHaveBeenCalledTimes(1)
    const ev = dispatchEvent.mock.calls[0][0] as CustomEvent<{ kind: string; message: string }>
    expect(ev.type).toBe('nodeterm:toast')
    expect(ev.detail.kind).toBe('error')
    expect(ev.detail.message).toMatch(/http/i)
  })

  it('does not blame plain http when the failure happens in a secure context', () => {
    const { doc } = fakeDocument(() => false)
    const dispatchEvent = vi.fn()
    vi.stubGlobal('navigator', {})
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', { dispatchEvent, isSecureContext: true })
    buildStubApi().clipboard.writeText('hi')
    const ev = dispatchEvent.mock.calls[0][0] as CustomEvent<{ message: string }>
    expect(ev.detail.message).not.toMatch(/plain http/i)
    expect(ev.detail.message).toMatch(/copy/i)
  })
})
