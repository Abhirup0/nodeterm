// The background poll gate: on desktop `shouldPoll` is "window focused" (for the pill), but the
// phone reads the mirror's `usage` block with no window focused, so `mirrorMayBeRead` must be able
// to open the gate on its own — otherwise a backgrounded desktop froze the phone's bars into
// fossils (the same "nobody looking" starvation the Server Edition avoids by polling ungated).
//
// Observed through `localAccounts`: pollAll calls it ONLY after the gate passes, so a spy on it is
// a clean proxy for "did the background poll fire?" (run() itself is fire-and-forget and, with no
// credentials in a test, resolves to an error usage — localAccounts is the deterministic signal).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { initPlatform, resetPlatformForTests } from '../platform'
import { fakePlatform } from '../platform-fake'
import { startUsageService, type UsageService } from './usage-service'

let service: UsageService | undefined

beforeEach(() => {
  resetPlatformForTests()
  initPlatform(fakePlatform())
})

afterEach(() => {
  service?.dispose()
  service = undefined
  resetPlatformForTests()
})

describe('usage poll gate', () => {
  it('does NOT poll when the shell gate is shut and no phone may read the mirror', () => {
    const localAccounts = vi.fn(() => ['acc-1'])
    service = startUsageService({
      shouldPoll: () => false,
      mirrorMayBeRead: () => false,
      localAccounts
    })
    // The warm-up pollAll runs at start; a closed gate must skip it entirely.
    expect(localAccounts).not.toHaveBeenCalled()
  })

  it('polls when the shell gate is shut but a phone MAY be reading the mirror', () => {
    const localAccounts = vi.fn(() => ['acc-1'])
    service = startUsageService({
      shouldPoll: () => false,
      mirrorMayBeRead: () => true,
      localAccounts
    })
    // The phone-facing mirror needs fresh data even with the window unfocused → the poll fires.
    expect(localAccounts).toHaveBeenCalled()
  })

  it('polls when the shell gate is open, regardless of the mirror signal', () => {
    const localAccounts = vi.fn(() => ['acc-1'])
    service = startUsageService({
      shouldPoll: () => true,
      mirrorMayBeRead: () => false,
      localAccounts
    })
    expect(localAccounts).toHaveBeenCalled()
  })

  it('defaults mirrorMayBeRead to never — a shut shell gate alone skips the poll (legacy behavior)', () => {
    const localAccounts = vi.fn(() => ['acc-1'])
    service = startUsageService({ shouldPoll: () => false, localAccounts })
    expect(localAccounts).not.toHaveBeenCalled()
  })
})
