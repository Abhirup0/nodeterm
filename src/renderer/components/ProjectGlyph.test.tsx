// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ProjectGlyph } from './ProjectGlyph'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('ProjectGlyph', () => {
  let root: Root
  let host: HTMLElement

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  const render = async (el: React.ReactElement): Promise<void> => {
    await act(async () => root.render(el))
  }

  it('renders an emoji icon as its literal character', async () => {
    await render(
      <ProjectGlyph icon={{ type: 'emoji', emoji: '🚀' }} color="#f00" name="Rocket" />
    )
    expect(host.textContent).toBe('🚀')
  })

  // Task 4 swapped the placeholder for the real curated lucide-react map. lucide renders an <svg>
  // whose `stroke` is the `color` prop, so these two pin the same thing 1:1 (tinted / currentColor)
  // against the real glyph instead of the former placeholder rect.
  it('renders a lucide icon as a tinted lucide <svg>', async () => {
    await render(
      <ProjectGlyph icon={{ type: 'lucide', name: 'folder' }} color="#3355ff" name="Folder Project" />
    )
    const svg = host.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('stroke')).toBe('#3355ff')
    expect(svg?.classList.contains('lucide-folder')).toBe(true)
  })

  it('falls back to currentColor for the lucide glyph when no color is given', async () => {
    await render(<ProjectGlyph icon={{ type: 'lucide', name: 'folder' }} name="No Color" />)
    const svg = host.querySelector('svg')
    expect(svg?.getAttribute('stroke')).toBe('currentColor')
  })

  it('renders an image icon as an <img> with the given src', async () => {
    await render(
      <ProjectGlyph
        icon={{ type: 'image', src: 'data:image/png;base64,AA==', source: 'upload' }}
        color="#000"
        name="Img Project"
      />
    )
    const img = host.querySelector('img')
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,AA==')
    expect(img?.getAttribute('alt')).toBe('')
  })

  it('falls back to a colored dot when icon is absent and variant is "dot"', async () => {
    await render(<ProjectGlyph color="#abc123" name="Dotty" variant="dot" className="tab__dot" />)
    const span = host.querySelector('span.tab__dot')
    expect(span).not.toBeNull()
    expect(span?.textContent).toBe('')
    expect((span as HTMLElement).style.background).toBe('rgb(171, 193, 35)')
  })

  it('dot fallback has no inline style at all when color is undefined (matches an inactive tab)', async () => {
    await render(<ProjectGlyph name="Dotty" variant="dot" className="tab__dot" />)
    const span = host.querySelector('span.tab__dot')
    expect(span?.getAttribute('style')).toBeNull()
  })

  it('falls back to a colored monogram (first initial) by default when icon is absent', async () => {
    await render(<ProjectGlyph color="#112233" name="Alpha Project" className="ss-mark--project" />)
    const span = host.querySelector('span.ss-mark--project')
    expect(span?.textContent).toBe('A')
    expect((span as HTMLElement).style.background).toBe('rgb(17, 34, 51)')
  })

  it('monogram fallback uses "?" for an empty/whitespace name', async () => {
    await render(<ProjectGlyph color="#112233" name="   " variant="monogram" />)
    expect(host.textContent).toBe('?')
  })

  it('passes className and title through on every fallback branch', async () => {
    await render(
      <ProjectGlyph color="#fff" name="Titled" variant="monogram" className="my-class" title="Titled" />
    )
    const span = host.querySelector('span.my-class')
    expect(span?.getAttribute('title')).toBe('Titled')
  })
})
