import { describe, it, expect } from 'vitest'
import type { LicenseDetail } from '@shared/types'
import { licenseSentence, canReleaseDevices } from './licenseCopy'

// `detail.error` carries TWO families and only the code word separates them: a read that FAILED
// (its counts are placeholder zeros) and a release that was REFUSED (its counts are the last good
// read — real, current, worth showing). Most of what follows exists to pin that seam, because
// every wrong ordering of the checks still produces a plausible-looking sentence.

const keygen = (over: Partial<LicenseDetail> = {}): LicenseDetail => ({
  key: 'NT-KEY-1',
  used: 2,
  seats: 3,
  source: 'keygen',
  error: null,
  ...over
})

describe('licenseSentence — a keygen license that read cleanly', () => {
  it('reports usage against the cap and names phones as devices', () => {
    const s = licenseSentence(keygen({ used: 2, seats: 3 }))
    expect(s).toBe('2 of 3 devices in use — this Mac and each paired phone counts as a device.')
    // The numbers are the DATA's, not a template that happens to read well: a swapped pair or a
    // hardcoded cap would still match a looser assertion.
    expect(licenseSentence(keygen({ used: 1, seats: 5 }))).toBe(
      '1 of 5 devices in use — this Mac and each paired phone counts as a device.'
    )
  })

  it('names the cap being full and points at the release action', () => {
    expect(licenseSentence(keygen({ used: 3, seats: 3 }))).toBe(
      'All 3 devices are in use. Release the others below to free them up.'
    )
  })

  it('does not claim "all N" when MORE than N are in use (a cap lowered after activation)', () => {
    // `used > seats` is reachable and must not be flattened into the full-cap sentence: "All 3
    // devices are in use" under a 4-device reality is a wrong number stated as a fact. A `>=`
    // that falls through to the full-cap branch passes every other test in this file.
    expect(licenseSentence(keygen({ used: 4, seats: 3 }))).toBe(
      '4 devices are in use, more than the 3 this license allows. Release the others below to free them up.'
    )
  })

  it('is honest when the read succeeded but no key is on file', () => {
    // Legitimate: a keygen policy that hides keys, or a license predating the key column. This is
    // the ONLY case this sentence may appear in — see the apple/free/error tests below.
    expect(licenseSentence(keygen({ key: null }))).toBe(
      'No key is on file for this license yet — get in touch and we will send yours.'
    )
  })
})

describe('licenseSentence — sources that have no key and no device count', () => {
  it('says an App Store subscription bridged Pro here, and prints no counts', () => {
    const s = licenseSentence({ key: null, used: 0, seats: 0, source: 'apple', error: null })
    expect(s).toBe(
      'Pro on this Mac comes from the App Store subscription on your paired phone, so there is no license key or device count to show here.'
    )
    // The zeros are "not applicable", not a measurement. Rendering them here is the exact
    // misdirection this branch exists to prevent.
    expect(s).not.toContain('0')
    // …and it must not borrow the keygen "no key on file" line, which would send an App Store
    // subscriber to support asking for a key that will never exist.
    expect(s).not.toContain('get in touch')
  })

  it('says plainly that a `free` source is not backed by a key, inventing no origin story', () => {
    const s = licenseSentence({ key: null, used: 0, seats: 0, source: 'free', error: null })
    expect(s).toBe('Pro on this device is not backed by a license key.')
    expect(s).not.toContain('get in touch')
    expect(s).not.toContain('0')
  })

  it('says nothing when a clean read stated no source at all', () => {
    // Only reachable through a release merge over an empty detail (counts real, source unknown).
    // With no stated source there is no sentence the data supports — so, none.
    expect(licenseSentence({ key: null, used: 1, seats: 3, source: null, error: null })).toBe('')
  })
})

describe('licenseSentence — a read that FAILED', () => {
  // Every code in this family arrives with placeholder zeros and a null key.
  const failures = ['unauthorized', 'inactive', 'offline', 'disabled', 'network'] as const
  const FAILED = 'Could not read this license right now, so the key and device count are unknown. Your Pro access is unaffected.'

  for (const error of failures) {
    it(`renders "${error}" as a failed read, never as a device count`, () => {
      const s = licenseSentence({ key: null, used: 0, seats: 0, source: null, error })
      expect(s).toBe(FAILED)
      // A failed read is not "0 of 0 devices" and not "no key on file".
      expect(s).not.toContain('0 of 0')
      expect(s).not.toContain('get in touch')
    })
  }

  it('still renders the failure when the failed read carried a source and stale-looking counts', () => {
    // ORDERING PIN: if the `source` check ran before the `error` check, this would render the
    // keygen usage sentence over a read that never came back — a fabricated device count.
    const s = licenseSentence({ key: 'NT-KEY-1', used: 2, seats: 3, source: 'keygen', error: 'offline' })
    expect(s).toBe(FAILED)
    expect(s).not.toContain('2 of 3')
  })
})

describe('licenseSentence — a release that was REFUSED', () => {
  it('says when releasing is possible again, in days', () => {
    // ORDERING PIN, the other direction: this detail is a clean keygen read with a refusal code on
    // top. Falling through to the read-failure sentence would tell the user their license could
    // not be read, when in fact it was read fine and only the ACTION was refused.
    const s = licenseSentence(keygen({ error: 'too_soon', retryAfterDays: 12 }))
    expect(s).toBe('You can release devices again in 12 days.')
    expect(s).not.toContain('Could not read')
  })

  it('says "1 day", not "1 days"', () => {
    expect(licenseSentence(keygen({ error: 'too_soon', retryAfterDays: 1 }))).toBe(
      'You can release devices again in 1 day.'
    )
  })

  it('invents no window when the server stated no retryAfterDays', () => {
    // A default like `?? 30` is a number the server never sent, printed as a date the user will
    // plan around. Degrade to nothing, never to something wrong.
    expect(licenseSentence(keygen({ error: 'too_soon' }))).toBe(
      'You cannot release devices again yet.'
    )
    expect(licenseSentence(keygen({ error: 'too_soon', retryAfterDays: 0 }))).toBe(
      'You cannot release devices again yet.'
    )
  })

  it('renders not_applicable as a refused action, not as a failed read', () => {
    // Unreachable through the UI (the release action is shown only for a STATED 'keygen' source,
    // and that is the one source the route never answers 400 for), but a route contract is not a
    // render-time guarantee — so it gets a sentence rather than the failed-read one.
    const s = licenseSentence({ key: null, used: 0, seats: 0, source: 'apple', error: 'not_applicable' })
    expect(s).toBe('Releasing devices does not apply to this license.')
    expect(s).not.toContain('Could not read')
  })
})

describe('licenseSentence — before the first read', () => {
  it('says nothing', () => {
    expect(licenseSentence(null)).toBe('')
  })
})

describe('canReleaseDevices', () => {
  it('is true only for a STATED keygen source', () => {
    expect(canReleaseDevices(keygen())).toBe(true)
  })

  it('is false for every other stated source', () => {
    expect(canReleaseDevices({ key: null, used: 0, seats: 0, source: 'apple', error: null })).toBe(
      false
    )
    expect(canReleaseDevices({ key: null, used: 0, seats: 0, source: 'free', error: null })).toBe(
      false
    )
  })

  it('is false when no source was stated — an unknown source HIDES the action', () => {
    // The gate must be `=== 'keygen'`, never `!== 'apple'`: a null source (every error reply, and
    // the release route's own 200) would then SHOW a release the server can only refuse, and a
    // future source word would inherit the button by default. Both of these pass a `!== 'apple'`.
    expect(canReleaseDevices({ key: null, used: 0, seats: 0, source: null, error: 'offline' })).toBe(
      false
    )
    expect(
      canReleaseDevices({
        key: null,
        used: 0,
        seats: 0,
        source: 'ios' as unknown as LicenseDetail['source'],
        error: null
      })
    ).toBe(false)
  })

  it('is false before the first read', () => {
    expect(canReleaseDevices(null)).toBe(false)
  })

  it('stays true while a release is throttled — the action is refused, not inapplicable', () => {
    // The user must still see the button (and the "in N days" sentence beside it); hiding it here
    // would read as "this license cannot release devices at all".
    expect(canReleaseDevices(keygen({ error: 'too_soon', retryAfterDays: 12 }))).toBe(true)
  })
})
