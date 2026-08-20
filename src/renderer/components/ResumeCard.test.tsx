// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { NavStop, Project } from '@shared/types'
import { ResumeCard } from './ResumeCard'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

function project(breadcrumbs: NavStop[] = []): Project {
  return {
    id: 'p1',
    name: 'p',
    color: '#0a84ff',
    viewport: { x: 0, y: 0, zoom: 1 },
    nodes: [],
    breadcrumbs
  }
}

describe('ResumeCard', () => {
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

  const renderCard = async (
    p: Project,
    nodes: { id: string }[],
    onOpen: (id: string) => void
  ): Promise<void> => {
    await act(async () => {
      root.render(<ResumeCard project={p} nodes={nodes} onOpen={onOpen} />)
    })
  }

  const click = async (el: Element): Promise<void> => {
    await act(async () => {
      el.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    })
  }

  const rows = (): NodeListOf<HTMLElement> =>
    host.querySelectorAll<HTMLElement>('[data-testid="resume-card-row"]')

  it('renders nothing when there are no breadcrumbs', async () => {
    await renderCard(project([]), [], () => {})
    expect(host.querySelector('.resume-card')).toBeNull()
  })

  it('renders nothing when every breadcrumb points at a deleted node', async () => {
    await renderCard(project([{ nodeId: 'gone', at: 1000, note: 'terminal · t' }]), [], () => {})
    expect(host.querySelector('.resume-card')).toBeNull()
  })

  it('shows the last 3 live breadcrumbs, newest first', async () => {
    const breadcrumbs: NavStop[] = [
      { nodeId: 'a', at: 1000, note: 'terminal · A' },
      { nodeId: 'b', at: 2000, note: 'terminal · B' },
      { nodeId: 'c', at: 3000, note: 'terminal · C' },
      { nodeId: 'd', at: 4000, note: 'terminal · D' }
    ]
    await renderCard(
      project(breadcrumbs),
      [{ id: 'a' }, { id: 'b' }, { id: 'c' }, { id: 'd' }],
      () => {}
    )
    expect(rows()).toHaveLength(3)
    expect(rows()[0].textContent).toContain('terminal · D')
    expect(rows()[2].textContent).toContain('terminal · B')
  })

  it('skips breadcrumbs whose node is gone when picking the last 3', async () => {
    // The cap is over LIVE stops, not over the raw tail: filtering after slicing would show
    // fewer than three rows on a trail whose newest entries point at deleted nodes.
    const breadcrumbs: NavStop[] = [
      { nodeId: 'a', at: 1000, note: 'terminal · A' },
      { nodeId: 'b', at: 2000, note: 'terminal · B' },
      { nodeId: 'dead', at: 3000, note: 'terminal · X' },
      { nodeId: 'c', at: 4000, note: 'terminal · C' }
    ]
    await renderCard(project(breadcrumbs), [{ id: 'a' }, { id: 'b' }, { id: 'c' }], () => {})
    expect(rows()).toHaveLength(3)
    expect(rows()[0].textContent).toContain('terminal · C')
    expect(rows()[1].textContent).toContain('terminal · B')
    expect(rows()[2].textContent).toContain('terminal · A')
  })

  it('offers a revisited node once, at its newest position', async () => {
    // A breadcrumb list is a HISTORY: recordBreadcrumb appends the same node again once the dedupe
    // window has passed, so an ordinary A → B → A round trip lists 'a' twice. Two rows for one
    // place would spend a slot saying nothing new (and collide as React keys).
    const breadcrumbs: NavStop[] = [
      { nodeId: 'a', at: 1000, note: 'terminal · A' },
      { nodeId: 'b', at: 2000, note: 'terminal · B' },
      { nodeId: 'a', at: 3000, note: 'terminal · A again' },
      { nodeId: 'c', at: 4000, note: 'terminal · C' }
    ]
    await renderCard(project(breadcrumbs), [{ id: 'a' }, { id: 'b' }, { id: 'c' }], () => {})
    expect(rows()).toHaveLength(3)
    expect(rows()[0].textContent).toContain('terminal · C')
    // 'a' takes the newest occurrence's slot (ahead of 'b'), carrying that occurrence's note.
    expect(rows()[1].textContent).toContain('terminal · A again')
    expect(rows()[2].textContent).toContain('terminal · B')
  })

  it('fills all 3 slots from further back when a node is revisited', async () => {
    // De-duping must not COST a row: the card still offers three distinct places when the trail
    // holds them, even though its newest four entries only name three nodes.
    const breadcrumbs: NavStop[] = [
      { nodeId: 'a', at: 1000, note: 'terminal · A' },
      { nodeId: 'b', at: 2000, note: 'terminal · B' },
      { nodeId: 'c', at: 3000, note: 'terminal · C' },
      { nodeId: 'b', at: 4000, note: 'terminal · B again' }
    ]
    await renderCard(project(breadcrumbs), [{ id: 'a' }, { id: 'b' }, { id: 'c' }], () => {})
    expect(rows()).toHaveLength(3)
    expect(rows()[0].textContent).toContain('terminal · B again')
    expect(rows()[1].textContent).toContain('terminal · C')
    expect(rows()[2].textContent).toContain('terminal · A')
  })

  it('does not warn about duplicate React keys when a node is revisited', async () => {
    // The de-dupe is a behavior rule; the keys must be unique on their own terms. A console.error
    // here is React's "Encountered two children with the same key" — the app console and this
    // suite's output are both meant to be pristine.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await renderCard(
        project([
          { nodeId: 'a', at: 1000, note: 'terminal · A' },
          { nodeId: 'a', at: 2000, note: 'terminal · A again' }
        ]),
        [{ id: 'a' }],
        () => {}
      )
      expect(rows()).toHaveLength(1)
      expect(spy).not.toHaveBeenCalled()
    } finally {
      spy.mockRestore()
    }
  })

  it('clicking a row calls onOpen with the node id', async () => {
    const onOpen = vi.fn<(id: string) => void>()
    await renderCard(
      project([{ nodeId: 'a', at: 1000, note: 'terminal · A' }]),
      [{ id: 'a' }],
      onOpen
    )
    await click(rows()[0])
    expect(onOpen).toHaveBeenCalledWith('a')
  })

  it('the dismiss button hides the card', async () => {
    await renderCard(
      project([{ nodeId: 'a', at: 1000, note: 'terminal · A' }]),
      [{ id: 'a' }],
      () => {}
    )
    await click(host.querySelector('.resume-card__close')!)
    expect(host.querySelector('.resume-card')).toBeNull()
  })

  it('stays dismissed when the parent re-renders with a new breadcrumb', async () => {
    // A breadcrumb recorded while the card is up must not resurrect a card the user just closed.
    const p1 = project([{ nodeId: 'a', at: 1000, note: 'terminal · A' }])
    await renderCard(p1, [{ id: 'a' }], () => {})
    await click(host.querySelector('.resume-card__close')!)
    const p2 = project([
      { nodeId: 'a', at: 1000, note: 'terminal · A' },
      { nodeId: 'b', at: 2000, note: 'terminal · B' }
    ])
    await renderCard(p2, [{ id: 'a' }, { id: 'b' }], () => {})
    expect(host.querySelector('.resume-card')).toBeNull()
  })
})
