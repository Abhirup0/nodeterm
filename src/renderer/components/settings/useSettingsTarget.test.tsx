// @vitest-environment jsdom
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { FIRST_SECTION_ID, type SettingsSectionId } from './nav'
import { useSettingsTarget, type SettingsTarget } from './useSettingsTarget'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

describe('useSettingsTarget', () => {
  let root: Root
  let host: HTMLElement
  let target: SettingsTarget

  function Probe({
    initialSection,
    retargetNonce
  }: {
    initialSection?: SettingsSectionId
    retargetNonce?: number
  }): React.JSX.Element {
    target = useSettingsTarget(initialSection, retargetNonce)
    return <div>{target.active}</div>
  }

  const render = async (props: {
    initialSection?: SettingsSectionId
    retargetNonce?: number
  }): Promise<void> => {
    await act(async () => {
      root.render(<Probe {...props} />)
    })
  }

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('opens on the first section when no caller asked for one', async () => {
    await render({})
    expect(target.active).toBe(FIRST_SECTION_ID)
    expect(target.query).toBe('')
  })

  it('opens on the section a deep link asked for', async () => {
    await render({ initialSection: 'project-p1' as SettingsSectionId, retargetNonce: 1 })
    expect(target.active).toBe('project-p1')
  })

  it('re-targets AND clears a stale query when the nonce is bumped for the SAME section', async () => {
    await render({ initialSection: 'project-p1' as SettingsSectionId, retargetNonce: 1 })
    await act(async () => {
      target.setActive('ssh')
      target.setQuery('zzzznomatch')
    })
    expect(target.active).toBe('ssh')
    // Deep-linked to the same project again: only the nonce changes.
    await render({ initialSection: 'project-p1' as SettingsSectionId, retargetNonce: 2 })
    expect(target.active).toBe('project-p1')
    // A filter left in the box would hide the pane the link just navigated to.
    expect(target.query).toBe('')
  })

  it('leaves the user\'s in-dialog section and query alone when nothing re-targets', async () => {
    await render({ initialSection: 'project-p1' as SettingsSectionId, retargetNonce: 1 })
    await act(async () => {
      target.setActive('ssh')
      target.setQuery('shell')
    })
    // A plain re-render (parent state changed elsewhere): same section, same nonce.
    await render({ initialSection: 'project-p1' as SettingsSectionId, retargetNonce: 1 })
    expect(target.active).toBe('ssh')
    expect(target.query).toBe('shell')
  })

  it('never clears the query for a plain open, which passes no section at all', async () => {
    await render({})
    await act(async () => {
      target.setQuery('shell')
    })
    await render({ retargetNonce: undefined })
    expect(target.query).toBe('shell')
  })
})

/**
 * `active` outlives the dialog: Canvas keeps `settingsSection` across opens. So a project pane it
 * points at can disappear (project closed) while the selection stays — and the panel then opens on
 * a section nobody renders: no nav row, blank main area.
 */
describe('useSettingsTarget project fallback', () => {
  let root: Root
  let host: HTMLElement
  let target: SettingsTarget

  function Probe({
    initialSection,
    retargetNonce,
    openProjectIds
  }: {
    initialSection?: SettingsSectionId
    retargetNonce?: number
    openProjectIds?: string[]
  }): React.JSX.Element {
    target = useSettingsTarget(initialSection, retargetNonce, openProjectIds)
    return <div>{target.active}</div>
  }

  const render = async (props: {
    initialSection?: SettingsSectionId
    retargetNonce?: number
    openProjectIds?: string[]
  }): Promise<void> => {
    await act(async () => {
      root.render(<Probe {...props} />)
    })
  }

  beforeEach(() => {
    host = document.createElement('div')
    document.body.appendChild(host)
    root = createRoot(host)
  })

  afterEach(() => {
    act(() => root.unmount())
    host.remove()
  })

  it('falls back to the first section when the active project closes', async () => {
    await render({ initialSection: 'project-p1' as SettingsSectionId, retargetNonce: 1, openProjectIds: ['p1', 'p2'] })
    expect(target.active).toBe('project-p1')
    // p1 closed while the dialog was shut; the selection is still pointing at its pane.
    await render({ openProjectIds: ['p2'] })
    expect(target.active).toBe(FIRST_SECTION_ID)
  })

  it('refuses a deep link to a project that has no pane', async () => {
    await render({ initialSection: 'project-gone' as SettingsSectionId, retargetNonce: 1, openProjectIds: ['p1'] })
    expect(target.active).toBe(FIRST_SECTION_ID)
  })

  it('leaves a live project section, and every non-project section, alone', async () => {
    await render({ initialSection: 'project-p1' as SettingsSectionId, retargetNonce: 1, openProjectIds: ['p1'] })
    expect(target.active).toBe('project-p1')
    await act(async () => target.setActive('ssh'))
    await render({ openProjectIds: [] })
    expect(target.active).toBe('ssh')
  })

  it('never falls back when the caller passes no project list at all', async () => {
    // `undefined` is "I have no list", not "no projects are open": a caller whose projects have not
    // loaded yet must not bulldoze a legitimate deep link.
    await render({ initialSection: 'project-p1' as SettingsSectionId, retargetNonce: 1 })
    expect(target.active).toBe('project-p1')
  })
})
