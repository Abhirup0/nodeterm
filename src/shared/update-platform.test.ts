import { describe, expect, it } from 'vitest'
import { isManualUpdatePlatform, toUpdateAvailablePayload } from './update-platform'

describe('isManualUpdatePlatform', () => {
  it('linux with APPIMAGE set → auto (self-installs)', () => {
    expect(isManualUpdatePlatform('linux', true)).toBe(false)
  })

  it('linux without APPIMAGE → manual (.deb/.rpm)', () => {
    expect(isManualUpdatePlatform('linux', false)).toBe(true)
  })

  it('darwin → auto regardless of APPIMAGE', () => {
    expect(isManualUpdatePlatform('darwin', false)).toBe(false)
    expect(isManualUpdatePlatform('darwin', true)).toBe(false)
  })

  it('win32 → auto', () => {
    expect(isManualUpdatePlatform('win32', false)).toBe(false)
  })
})

describe('toUpdateAvailablePayload', () => {
  it('carries version + string release notes + manual flag', () => {
    expect(toUpdateAvailablePayload({ version: '1.2.0', releaseNotes: 'fixes' }, true)).toEqual({
      version: '1.2.0',
      notes: 'fixes',
      manual: true
    })
  })

  it('coerces non-string / missing release notes to empty string', () => {
    expect(toUpdateAvailablePayload({ version: '1.2.0' }, false)).toEqual({
      version: '1.2.0',
      notes: '',
      manual: false
    })
    expect(
      toUpdateAvailablePayload({ version: '1.2.0', releaseNotes: [{ note: 'x' }] }, false).notes
    ).toBe('')
  })
})
