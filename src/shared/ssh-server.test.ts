import { describe, expect, it } from 'vitest'
import { hostOsFromPlatform, sshServerCopy, type HostOs } from './ssh-server'

describe('hostOsFromPlatform', () => {
  it('maps the two platforms with their own name for sshd, everything else to the generic case', () => {
    expect(hostOsFromPlatform('darwin')).toBe('mac')
    expect(hostOsFromPlatform('win32')).toBe('windows')
    expect(hostOsFromPlatform('linux')).toBe('other')
    expect(hostOsFromPlatform('freebsd')).toBe('other')
  })
})

describe('sshServerCopy', () => {
  const all: HostOs[] = ['mac', 'windows', 'other']

  it('names the service the OS actually has', () => {
    expect(sshServerCopy('mac').name).toBe('Remote Login')
    // Issue #572: on Windows the warning said "Remote Login", a setting that does not exist there,
    // so the instruction could not be followed as written.
    expect(sshServerCopy('windows').name).toBe('OpenSSH Server')
    expect(sshServerCopy('other').name).not.toMatch(/Remote Login|OpenSSH Server/)
  })

  it('tells a Windows user BOTH steps — it is an optional feature, not a toggle', () => {
    const how = sshServerCopy('windows').how
    expect(how).toMatch(/Optional features/)
    expect(how).toMatch(/sshd|SSH Server/)
  })

  it('offers a deep link only where main can open one, and never a foreign scheme', () => {
    expect(sshServerCopy('mac').settingsUrl).toMatch(/^x-apple\.systempreferences:/)
    expect(sshServerCopy('windows').settingsUrl).toMatch(/^ms-settings:/)
    // No URL for the generic case: a button that opens nothing is what this issue was about.
    expect(sshServerCopy('other').settingsUrl).toBeUndefined()
  })

  it('keeps label and URL together — the UI shows the button on the label', () => {
    for (const os of all) {
      const copy = sshServerCopy(os)
      expect(Boolean(copy.settingsLabel)).toBe(Boolean(copy.settingsUrl))
      expect(copy.name.length).toBeGreaterThan(0)
      expect(copy.how.length).toBeGreaterThan(0)
    }
  })
})
