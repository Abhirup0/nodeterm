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
