/** One-shot flag: the mobile-launch announcement has been shown and closed (or pre-empted by
 *  the setup tour, whose phone step makes the same pitch to fresh installs). localStorage, not
 *  settings — it is per-machine presentation state, like dismissed announcement banners.
 *
 *  Lives apart from `MobileLaunchCard` because Canvas reads the flag on EVERY launch to decide
 *  whether to render the card at all: importing it from the component would pull the card — and
 *  the onboarding scene artwork it draws — into the startup chunk for the (overwhelmingly common)
 *  case where the answer is "no, already seen". */
const MOBILE_LAUNCH_SEEN_KEY = 'nodeterm.seenMobileLaunch'

export function markMobileLaunchSeen(): void {
  try {
    localStorage.setItem(MOBILE_LAUNCH_SEEN_KEY, '1')
  } catch {
    // storage unavailable: worst case the card shows again next launch
  }
}

export function shouldShowMobileLaunch(): boolean {
  try {
    return localStorage.getItem(MOBILE_LAUNCH_SEEN_KEY) == null
  } catch {
    return false
  }
}
