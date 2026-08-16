import type { LicenseDetail } from '@shared/types'

/**
 * Settings → License wording, derived from the data in ONE place so a sentence cannot promise
 * something the numbers do not say.
 *
 * Two facts shape every branch below:
 *
 * 1. **`error` carries TWO families and only the code word separates them.** A READ that failed
 *    (`unauthorized` | `inactive` | `offline` | `disabled` | `network`) arrives with placeholder
 *    zeros and a null key — rendering those as a device count is the bug this module exists to
 *    prevent. A refused RELEASE (`too_soon` | `not_applicable`) rides on top of the LAST GOOD
 *    read, so its key, source and counts are real; telling that user "could not read your
 *    license" would be equally wrong in the other direction. Hence: error first, then which
 *    family, then the source.
 * 2. **Seats and devices are the same thing by design**, so the copy says "devices" and names
 *    phones explicitly — a paired phone holds a seat too, and a user who does not know that reads
 *    the cap as broken.
 */
export function licenseSentence(detail: LicenseDetail | null): string {
  if (!detail) return '' // Before the first read there is nothing to say.

  if (detail.error) {
    // --- Family 2 first: the read was FINE, the action was refused. -----------------------------
    if (detail.error === 'too_soon') {
      const days = detail.retryAfterDays
      // No `?? 30` fallback: a window the server never stated is a date the user would plan
      // around. Degrade to the shape of the fact we do have ("not yet"), never to a made-up number.
      if (typeof days === 'number' && Number.isFinite(days) && days > 0) {
        return `You can release devices again in ${days} ${days === 1 ? 'day' : 'days'}.`
      }
      return 'You cannot release devices again yet.'
    }
    if (detail.error === 'not_applicable') {
      // The panel only offers the release for a stated 'keygen' source, and that is the one source
      // the route never refuses this way — so this should be unreachable. It still gets its own
      // sentence rather than falling into the failed-read one, because a route contract is not a
      // render-time guarantee and "we could not read your license" would be a false alarm.
      return 'Releasing devices does not apply to this license.'
    }

    // --- Family 1: the READ failed. The counts beside this are placeholders, not a measurement. --
    // Deliberately not "could not reach the server": `unauthorized` / `inactive` / `disabled` are
    // answers we DID receive. What is true across the whole family is that we do not know the key
    // or the count — and that Pro keeps working either way (the entitlement is verified locally).
    return 'Could not read this license right now, so the key and device count are unknown. Your Pro access is unaffected.'
  }

  // --- A clean read. What can be said depends entirely on the source the SERVER stated. ---------
  if (detail.source === 'apple') {
    // No keygen call was made for this license, so `used`/`seats` are zeros meaning "not
    // applicable". Printing them would read as a cap that is somehow both empty and full.
    return 'Pro on this Mac comes from the App Store subscription on your paired phone, so there is no license key or device count to show here.'
  }
  if (detail.source === 'free') {
    // A defensive value. Say only what is certain — where it came from is not.
    return 'Pro on this device is not backed by a license key.'
  }
  if (detail.source === 'keygen') {
    if (!detail.key) {
      // Legitimate on a 200: a keygen policy that hides keys, or a license predating the column.
      // This is the only case in which this sentence is true.
      return 'No key is on file for this license yet — get in touch and we will send yours.'
    }
    if (detail.used > detail.seats) {
      // Reachable: a cap lowered after activation. "All N devices are in use" would understate it.
      return `${detail.used} devices are in use, more than the ${detail.seats} this license allows. Release the others below to free them up.`
    }
    if (detail.used === detail.seats) {
      return `All ${detail.seats} devices are in use. Release the others below to free them up.`
    }
    return `${detail.used} of ${detail.seats} devices in use — this Mac and each paired phone counts as a device.`
  }

  // A clean read that stated no source (only reachable by merging a release reply over an empty
  // detail). The counts may be real, but with no source there is no sentence they support.
  return ''
}

/**
 * Whether to offer "Release other devices".
 *
 * Gated on a STATED `'keygen'` — never on `!== 'apple'`. A null source is what every error reply
 * and the release route's own 200 carry, and a source word added later would inherit the button by
 * default; both would offer an action the server can only refuse. A refused release (`too_soon`)
 * still returns true: the action exists, it is merely throttled, and the sentence beside it says so.
 */
export function canReleaseDevices(detail: LicenseDetail | null): boolean {
  return detail?.source === 'keygen'
}
