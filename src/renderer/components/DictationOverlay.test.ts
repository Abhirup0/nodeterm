import { describe, expect, it } from 'vitest'
import { dictationMode, isAtRecordingCap, isProGateError, type DictationTarget } from './DictationOverlay'

const terminalTarget: DictationTarget = { kind: 'terminal', nodeId: 'n1', title: 'shell' }
const chatTarget: DictationTarget = { kind: 'chat', nodeId: 'n2', title: 'chat' }

// Press-to-talk: the pill is the default surface for both target kinds while a take is in
// flight; only a chat target's *transcribed* text ever reaches the editable card (a terminal
// target inserts directly and never has a 'text' phase at all — see DictationOverlay.stopRecording).
describe('dictationMode', () => {
  it('is "warning" whenever there is no target, regardless of phase', () => {
    expect(dictationMode(null, 'idle')).toBe('warning')
    expect(dictationMode(null, 'recording')).toBe('warning')
    expect(dictationMode(null, 'text')).toBe('warning')
  })

  it('is "pill" for a terminal target in every phase, including "text"', () => {
    expect(dictationMode(terminalTarget, 'idle')).toBe('pill')
    expect(dictationMode(terminalTarget, 'recording')).toBe('pill')
    expect(dictationMode(terminalTarget, 'transcribing')).toBe('pill')
    expect(dictationMode(terminalTarget, 'text')).toBe('pill')
  })

  it('is "pill" for a chat target until phase reaches "text"', () => {
    expect(dictationMode(chatTarget, 'idle')).toBe('pill')
    expect(dictationMode(chatTarget, 'recording')).toBe('pill')
    expect(dictationMode(chatTarget, 'transcribing')).toBe('pill')
  })

  it('is "card" only for a chat target once transcribed ("text" phase)', () => {
    expect(dictationMode(chatTarget, 'text')).toBe('card')
  })
})

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
