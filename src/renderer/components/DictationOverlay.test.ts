import { describe, expect, it } from 'vitest'
import { isAtRecordingCap } from './DictationOverlay'

// Base64 int16 PCM runs ~2.6 MB/min; WS_MAX_PAYLOAD (src/server/ws.ts) is 8 MiB, so an unbounded
// take would eventually blow the ws frame budget and drop the whole bridge. The 2:30 hard cap
// (MAX_RECORDING_MS) is what DictationOverlay's elapsed poller checks each tick to auto-stop
// well under that line — pin the boundary here since it isn't otherwise exercised by any test.
describe('isAtRecordingCap', () => {
  it('is false just under the 2:30 cap', () => {
    expect(isAtRecordingCap(149_999)).toBe(false)
  })

  it('is true exactly at the cap', () => {
    expect(isAtRecordingCap(150_000)).toBe(true)
  })

  it('is true past the cap', () => {
    expect(isAtRecordingCap(200_000)).toBe(true)
  })
})
