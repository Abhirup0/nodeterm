import { describe, expect, it } from 'vitest'
import { WHISPER_MODELS, whisperModel, WHISPER_DOWNLOAD_BASE } from './speech'
import { DEFAULT_SETTINGS } from './types'

describe('whisper model catalog', () => {
  it('matches the spec table exactly', () => {
    expect(WHISPER_MODELS.map((m) => m.id)).toEqual(['tiny', 'base', 'small', 'large-v3-turbo'])
    expect(WHISPER_MODELS.map((m) => m.file)).toEqual([
      'ggml-tiny.bin', 'ggml-base.bin', 'ggml-small.bin', 'ggml-large-v3-turbo.bin',
    ])
    // Only tiny is free — the Pro split the spec mandates.
    expect(WHISPER_MODELS.filter((m) => !m.pro).map((m) => m.id)).toEqual(['tiny'])
  })

  it('looks up by id and rejects unknowns', () => {
    expect(whisperModel('base')?.approxMB).toBe(142)
    expect(whisperModel('nope')).toBeUndefined()
  })

  it('download base is the whisper.cpp HF repo', () => {
    expect(WHISPER_DOWNLOAD_BASE).toBe('https://huggingface.co/ggerganov/whisper.cpp/resolve/main/')
  })

  it('speech settings default to free local dictation', () => {
    expect(DEFAULT_SETTINGS.speech).toEqual({
      engine: 'whisper',
      model: 'tiny',
      language: 'auto',
      shortcut: 'Cmd+Shift+D'
    })
  })
})
