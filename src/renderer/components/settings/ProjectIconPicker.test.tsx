// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProjectIcon } from '@shared/project-icon'
import { ProjectIconPicker } from './ProjectIconPicker'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

// The heavy library is mocked with a factory that counts how many times it is EVALUATED. Because
// EmojiPickerLazy imports it dynamically (React.lazy), the factory does not run until the Emoji tab
// is actually rendered — which is exactly the laziness this pins.
const H = vi.hoisted(() => ({ emojiLoads: 0 }))
vi.mock('emoji-picker-react', () => {
  H.emojiLoads++
  return {
    default: ({ onEmojiClick }: { onEmojiClick?: (d: { emoji: string }) => void }) => (
      <button data-testid="fake-emoji" onClick={() => onEmojiClick?.({ emoji: '🚀' })}>
        pick
      </button>
    )
  }
})

const COLORS = ['#0a84ff', '#32d74b', '#ff375f'] as const

describe('ProjectIconPicker', () => {
  let root: Root
  let host: HTMLElement
  let onIcon: ReturnType<typeof vi.fn<(i: ProjectIcon | undefined) => void>>
  let onColor: ReturnType<typeof vi.fn<(c: string) => void>>
  let pickProjectIcon: ReturnType<typeof vi.fn>

  const mount = async (icon?: ProjectIcon): Promise<void> => {
    root = createRoot(host)
    await act(async () => {
      root.render(
        <ProjectIconPicker
          projectId="p1"
          name="Alpha"
          icon={icon}
          color="#0a84ff"
          colors={COLORS}
          dark
          onIcon={onIcon}
          onColor={onColor}
        />
      )
    })
  }

  const click = async (el: Element | null): Promise<void> => {
    await act(async () => {
      el!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  /** Flush the lazy dynamic import + Suspense re-render. */
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 3; i++) await act(async () => await Promise.resolve())
  }

  const tab = (label: string): HTMLButtonElement =>
    [...host.querySelectorAll<HTMLButtonElement>('[role="tab"]')].find(
      (b) => b.textContent === label
    )!

  beforeEach(() => {
    H.emojiLoads = 0
    host = document.createElement('div')
    document.body.appendChild(host)
    onIcon = vi.fn()
    onColor = vi.fn()
    pickProjectIcon = vi.fn(async () => ({ dataUrl: 'data:image/png;base64,AA==' }))
    ;(window as unknown as { nodeTerminal: any }).nodeTerminal = {
      shell: { pickProjectIcon }
    }
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('defaults to the Lucide tab and does NOT load the emoji module', async () => {
    await mount()
    expect(tab('Lucide').getAttribute('aria-selected')).toBe('true')
    expect(H.emojiLoads).toBe(0)
  })

  it('picks a lucide glyph, sanitized, via its grid button', async () => {
    await mount()
    await click(host.querySelector('[data-lucide-id="rocket"]'))
    expect(onIcon).toHaveBeenCalledWith({ type: 'lucide', name: 'rocket' })
  })

  it('loads the emoji module only when the Emoji tab is opened, then emits the picked emoji', async () => {
    await mount()
    expect(H.emojiLoads).toBe(0)
    await click(tab('Emoji'))
    await flush()
    expect(H.emojiLoads).toBe(1)
    await click(host.querySelector('[data-testid="fake-emoji"]'))
    expect(onIcon).toHaveBeenCalledWith({ type: 'emoji', emoji: '🚀' })
  })

  it('re-encodes an uploaded image into an image icon via the main IPC', async () => {
    await mount()
    await click(tab('Upload'))
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Choose image…')!)
    await flush()
    expect(pickProjectIcon).toHaveBeenCalledTimes(1)
    expect(onIcon).toHaveBeenCalledWith({
      type: 'image',
      src: 'data:image/png;base64,AA==',
      source: 'upload'
    })
  })

  it('surfaces an upload error and commits nothing', async () => {
    pickProjectIcon.mockResolvedValue({ error: 'That image is too large even after resizing.' })
    await mount()
    await click(tab('Upload'))
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Choose image…')!)
    await flush()
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('too large')
    expect(onIcon).not.toHaveBeenCalled()
  })

  it('does nothing when the upload dialog is cancelled (null)', async () => {
    pickProjectIcon.mockResolvedValue(null)
    await mount()
    await click(tab('Upload'))
    await click([...host.querySelectorAll('button')].find((b) => b.textContent === 'Choose image…')!)
    await flush()
    expect(onIcon).not.toHaveBeenCalled()
    expect(host.querySelector('[role="alert"]')).toBeNull()
  })

  it('Reset clears the icon back to undefined (the colour monogram)', async () => {
    await mount({ type: 'emoji', emoji: '🚀' })
    const reset = host.querySelector<HTMLButtonElement>('[aria-label="Remove icon"]')!
    expect(reset.disabled).toBe(false)
    await click(reset)
    expect(onIcon).toHaveBeenCalledWith(undefined)
  })

  it('disables Reset when there is no icon to clear', async () => {
    await mount()
    expect(host.querySelector<HTMLButtonElement>('[aria-label="Remove icon"]')!.disabled).toBe(true)
  })

  it('offers Avatar as a disabled stub (Task 5)', async () => {
    await mount()
    expect(tab('Avatar').disabled).toBe(true)
  })

  it('picks a colour through the swatches', async () => {
    await mount()
    await click(host.querySelector('button[data-project-color="#32d74b"]'))
    expect(onColor).toHaveBeenCalledWith('#32d74b')
  })
})
