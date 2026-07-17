import { describe, expect, it } from 'vitest'
import { isAtRecordingCap, isProGateError } from './DictationOverlay'

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

// SpeechService.transcribeNow throws `The ${info.id} model requires nodeterm Pro — the tiny
// model is free.` for a Pro-gated model on a free account — DictationOverlay matches that shape
// to show a "See nodeterm Pro" action beside the inline error, so pin the substring match here.
describe('isProGateError', () => {
  it('matches the Pro-gate error thrown by SpeechService', () => {
    expect(isProGateError('The base model requires nodeterm Pro — the tiny model is free.')).toBe(
      true
    )
  })

  it('does not match an unrelated transcribe error', () => {
    expect(isProGateError('Transcription failed.')).toBe(false)
    expect(isProGateError('No speech detected.')).toBe(false)
    expect(isProGateError('Download the base model in Settings → Speech first.')).toBe(false)
  })
})
