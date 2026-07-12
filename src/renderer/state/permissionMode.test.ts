import { describe, it, expect, beforeEach } from 'vitest'
import { DEFAULT_SETTINGS } from '@shared/types'
import { useProjects } from './projects'
import { useSettings } from './settings'
import { activePermissionMode } from './permissionMode'

beforeEach(() => {
  useProjects.getState().hydrate({ version: 2, activeProjectId: '', projects: [] })
  useSettings.setState({ settings: { ...DEFAULT_SETTINGS }, hydrated: false })
})

describe('activePermissionMode', () => {
  it('returns the global setting when the active project has no override', () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, claudePermissionMode: 'plan' } }))
    const p = useProjects.getState().addProject('my-app', '/tmp/my-app')
    useProjects.getState().setActive(p.id)

    expect(activePermissionMode()).toBe('plan')
  })

  it("returns the active project's override, not another project's", () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, claudePermissionMode: 'auto' } }))
    const other = useProjects.getState().addProject('other', '/tmp/other')
    useProjects.getState().setProjectDefaultPermissionMode(other.id, 'bypassPermissions')
    const active = useProjects.getState().addProject('active', '/tmp/active')
    useProjects.getState().setProjectDefaultPermissionMode(active.id, 'acceptEdits')
    useProjects.getState().setActive(active.id)

    // The bug this test exists to catch: a stray project.find()-style lookup could pick up
    // the wrong project's override (e.g. the first one in the array) instead of the active one.
    expect(activePermissionMode()).toBe('acceptEdits')
    expect(activePermissionMode()).not.toBe('bypassPermissions')
  })

  it('falls back to the global setting when there is no active project', () => {
    useSettings.setState((s) => ({ settings: { ...s.settings, claudePermissionMode: 'manual' } }))
    useProjects.getState().addProject('solo', '/tmp/solo')
    useProjects.getState().setActive('nonexistent-id')

    expect(activePermissionMode()).toBe('manual')
  })
})
