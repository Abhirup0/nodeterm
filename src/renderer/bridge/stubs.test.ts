import { describe, it, expect } from 'vitest'
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
      s.context.onUpdate(() => {}),
      s.onCloseNode(() => {}),
      s.onFocusNode(() => {}),
      s.browser.onBrowserNewWindow(() => {}),
      s.onAgentControl(() => {}),
      s.sshProject.onStatus(() => {}),
      s.onSubagentActivity(() => {}),
      s.onAgentStatus(() => {}),
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

  it('void members are safe no-ops', () => {
    const s = buildStubApi()
    expect(() => {
      s.setBadgeCount(3)
      s.contextLink.setLinks({} as never)
      s.context.ensure('sid', '/cwd', undefined)
      s.sendAgentControlResult({} as never)
    }).not.toThrow()
  })
})
