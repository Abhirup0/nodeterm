import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { LicenseDetail, NodeTerminalApi } from '@shared/types'

// The license routes answer two DIFFERENT shapes, and that asymmetry is what these tests are about:
// `detail` states every field, while `release` answers with COUNTS ONLY — no key, no source. So the
// store replaces on the first and merges on the second; getting that backwards silently blanks the
// key the user came to copy, or renders "0 of 0 devices" from a call that never ran.
//
// The release's ERROR is split a second time, and that split is the other half of this file: a
// refusal (`too_soon` / `not_applicable`) is a fact about the license and rides `detail`; anything
// else is a fact about the CALL, is handed back to the caller, and must leave `detail` alone. Note
// what is NOT claimed anywhere below: that a failed release changed nothing on the server. For
// `offline`/`network` the request may well have landed and only the reply been lost.

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
    expect(await useEntitlement.getState().releaseOthers()).toBeNull()

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
    // Null: a refusal is a fact about the license, it rides `detail`, and licenseSentence speaks
    // for it. Returning it here as well would print the throttle twice, in two wordings.
    expect(await useEntitlement.getState().releaseOthers()).toBeNull()

    const d = useEntitlement.getState().detail!
    // Specifically the PRE-release values: 3, not 0. "Kept the old detail" and "wrote the reply's
    // zeros" are different outcomes, and only asserting the exact numbers tells them apart.
    expect(d.used).toBe(3)
    expect(d.seats).toBe(3)
    expect(d.key).toBe('KEY-ABC')
    expect(d.error).toBe('too_soon')
    expect(d.retryAfterDays).toBe(12)
  })

  it('a release that FAILED leaves the detail untouched and hands the code back', async () => {
    const useEntitlement = await freshStore()
    detail.mockResolvedValue(LOADED)
    await useEntitlement.getState().loadDetail()

    // Pressing "Release other devices" on a laptop that just lost wifi. Before this split, the
    // 'offline' code was merged onto `detail` and the panel replaced the device-count line with
    // "Could not read this license right now…" — while the real key sat in the box above it and
    // nothing on screen mentioned the release at all.
    releaseOthers.mockResolvedValue({ ...ZEROS, error: 'offline' })
    expect(await useEntitlement.getState().releaseOthers()).toBe('offline')

    // Byte for byte the last good read: not the reply's zeros, and not the last read plus an
    // `error`. An implementation that merges the code and ALSO returns it passes a bare
    // "returns the code" assertion and still shows the user a failed-read sentence.
    expect(useEntitlement.getState().detail).toEqual(LOADED)
  })

  it('does the same for every non-refusal code the release route can answer', async () => {
    const useEntitlement = await freshStore()
    detail.mockResolvedValue(LOADED)
    await useEntitlement.getState().loadDetail()

    // core/license.ts produces all of these on the release route too — the module doc that named
    // only too_soon/not_applicable was wrong about its own seam, which is how this shipped.
    for (const error of ['unauthorized', 'inactive', 'disabled', 'network']) {
      releaseOthers.mockResolvedValue({ ...ZEROS, error })
      expect(await useEntitlement.getState().releaseOthers(), error).toBe(error)
      expect(useEntitlement.getState().detail, error).toEqual(LOADED)
    }
  })

  it('a failed release with nothing read yet leaves detail null rather than inventing zeros', async () => {
    const useEntitlement = await freshStore()
    releaseOthers.mockResolvedValue({ ...ZEROS, error: 'offline' })

    expect(await useEntitlement.getState().releaseOthers()).toBe('offline')
    // Merging over EMPTY_DETAIL here would publish "0 of 0 devices, no key" as the license's
    // state, produced entirely by a call that never reached the server.
    expect(useEntitlement.getState().detail).toBeNull()
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
