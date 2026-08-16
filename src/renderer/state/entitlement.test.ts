import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { LicenseDetail, NodeTerminalApi } from '@shared/types'

// The license routes answer two DIFFERENT shapes, and that asymmetry is what these tests are about:
// `detail` states every field, while `release` answers with COUNTS ONLY — no key, no source (and a
// FAILED release changed nothing on the server at all). So the store replaces on the first and
// merges on the second; getting that backwards silently blanks the key the user came to copy, or
// renders "0 of 0 devices" from a call that never ran.

const detail = vi.fn<() => Promise<LicenseDetail>>()
const releaseOthers = vi.fn<() => Promise<LicenseDetail>>()

/** The last good read: a keygen license with its cap full. */
const LOADED: LicenseDetail = { key: 'KEY-ABC', used: 3, seats: 3, source: 'keygen', error: null }

/** Every failure (and every counts-only success) arrives shaped like this — zeros that are NOT a
 *  device count. What the store does with them is the whole point below. */
const ZEROS = { key: null, used: 0, seats: 0, source: null } as const

type Store = typeof import('./entitlement').useEntitlement

/** Fresh module graph per test: the store is created at import time and subscribes to
 *  window.nodeTerminal.license.onChange there, so the stub has to exist first. */
async function freshStore(): Promise<Store> {
  vi.resetModules()
  vi.stubGlobal('window', {
    nodeTerminal: {
      license: { detail, releaseOthers, onChange: () => () => {} }
    } as unknown as NodeTerminalApi
  })
  const { useEntitlement } = await import('./entitlement')
  return useEntitlement
}

beforeEach(() => {
  detail.mockReset()
  releaseOthers.mockReset()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('entitlement store — detail read vs release merge', () => {
  it('a successful release keeps the key and the source, and updates the counts', async () => {
    const useEntitlement = await freshStore()
    detail.mockResolvedValue(LOADED)
    await useEntitlement.getState().loadDetail()

    // The wire's answer to a successful release: counts only.
    releaseOthers.mockResolvedValue({ ...ZEROS, used: 1, seats: 3, error: null })
    await useEntitlement.getState().releaseOthers()

    const d = useEntitlement.getState().detail!
    // The key is the ORIGINAL string — not merely truthy, and not absent. A merge that wrote the
    // reply's `key: null` and one that dropped the field entirely both fail here.
    expect(d.key).toBe('KEY-ABC')
    // …and the source survives too: it is what decides whether this very action is offered.
    expect(d.source).toBe('keygen')
    expect(d).toEqual({ key: 'KEY-ABC', used: 1, seats: 3, source: 'keygen', error: null })
  })

  it('a 429 too_soon leaves the counts untouched and surfaces the retry window', async () => {
    const useEntitlement = await freshStore()
    detail.mockResolvedValue(LOADED)
    await useEntitlement.getState().loadDetail()

    releaseOthers.mockResolvedValue({ ...ZEROS, error: 'too_soon', retryAfterDays: 12 })
    await useEntitlement.getState().releaseOthers()

    const d = useEntitlement.getState().detail!
    // Specifically the PRE-release values: 3, not 0. "Kept the old detail" and "wrote the reply's
    // zeros" are different outcomes, and only asserting the exact numbers tells them apart.
    expect(d.used).toBe(3)
    expect(d.seats).toBe(3)
    expect(d.key).toBe('KEY-ABC')
    expect(d.error).toBe('too_soon')
    expect(d.retryAfterDays).toBe(12)
  })

  it('a 400 not_applicable likewise does not zero the counts', async () => {
    const useEntitlement = await freshStore()
    detail.mockResolvedValue(LOADED)
    await useEntitlement.getState().loadDetail()

    releaseOthers.mockResolvedValue({ ...ZEROS, error: 'not_applicable' })
    await useEntitlement.getState().releaseOthers()

    const d = useEntitlement.getState().detail!
    expect(d).toEqual({
      key: 'KEY-ABC',
      used: 3,
      seats: 3,
      source: 'keygen',
      error: 'not_applicable'
    })
    expect(d.retryAfterDays).toBeUndefined()
  })

  it('a successful release clears a previous throttle, window and all', async () => {
    const useEntitlement = await freshStore()
    detail.mockResolvedValue(LOADED)
    await useEntitlement.getState().loadDetail()

    releaseOthers.mockResolvedValue({ ...ZEROS, error: 'too_soon', retryAfterDays: 12 })
    await useEntitlement.getState().releaseOthers()
    expect(useEntitlement.getState().detail!.retryAfterDays).toBe(12)

    releaseOthers.mockResolvedValue({ ...ZEROS, used: 1, seats: 3, error: null })
    await useEntitlement.getState().releaseOthers()

    const d = useEntitlement.getState().detail!
    expect(d.error).toBeNull()
    // A stale window would tell the user to come back in 12 days for a release that just succeeded.
    expect(d.retryAfterDays).toBeUndefined()
  })

  it('a release with nothing read yet merges over empties instead of throwing', async () => {
    const useEntitlement = await freshStore()
    expect(useEntitlement.getState().detail).toBeNull()

    releaseOthers.mockResolvedValue({ ...ZEROS, used: 1, seats: 3, error: null })
    await useEntitlement.getState().releaseOthers()

    expect(useEntitlement.getState().detail).toEqual({
      key: null,
      used: 1,
      seats: 3,
      source: null,
      error: null
    })
  })

  it('loadDetail REPLACES wholesale — it is the one call that states every field', async () => {
    const useEntitlement = await freshStore()
    detail.mockResolvedValue(LOADED)
    await useEntitlement.getState().loadDetail()
    // Leave an OPTIONAL field in state first. Every other field is stated by the incoming reply,
    // so `{...prev, ...next}` is byte-identical to a replace and nothing could tell them apart;
    // `retryAfterDays` is the one thing a merge would carry over, so it is the discriminator.
    releaseOthers.mockResolvedValue({ ...ZEROS, error: 'too_soon', retryAfterDays: 12 })
    await useEntitlement.getState().releaseOthers()
    expect(useEntitlement.getState().detail!.retryAfterDays).toBe(12)

    // The same install re-read after the entitlement moved to an App Store purchase: no key, no
    // machines, source 'apple'. Merging here would keep a key that is no longer this license's
    // and a source that would keep offering a release the server can only refuse.
    const apple: LicenseDetail = { key: null, used: 0, seats: 0, source: 'apple', error: null }
    detail.mockResolvedValue(apple)
    await useEntitlement.getState().loadDetail()

    expect(useEntitlement.getState().detail).toEqual(apple)
    expect(useEntitlement.getState().detail!.retryAfterDays).toBeUndefined()
  })

  it('a failed read replaces too — its error is the state, not a footnote on stale counts', async () => {
    const useEntitlement = await freshStore()
    detail.mockResolvedValue(LOADED)
    await useEntitlement.getState().loadDetail()
    releaseOthers.mockResolvedValue({ ...ZEROS, error: 'too_soon', retryAfterDays: 12 })
    await useEntitlement.getState().releaseOthers()

    detail.mockResolvedValue({ ...ZEROS, error: 'offline' })
    await useEntitlement.getState().loadDetail()

    const d = useEntitlement.getState().detail!
    expect(d.error).toBe('offline')
    // The UI reads `error` first and must not render these as a device count — but they are the
    // read's own answer, so the store forwards them rather than papering over with the last ones.
    expect(d.key).toBeNull()
    expect(d.used).toBe(0)
    // …and the refused release's retry window does not survive a fresh read (see above).
    expect(d.retryAfterDays).toBeUndefined()
  })
})
