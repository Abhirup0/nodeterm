import { describe, expect, it } from 'vitest'
import {
  WHISPER_MODELS,
  whisperModel,
  WHISPER_DOWNLOAD_BASE,
  hasSpeechModel,
  modelAfterDownload,
  modelAfterDelete,
  SPEECH_MODEL_NONE,
  type ModelDownloadState
} from './speech'
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

  it('speech settings default to dictation OFF — nothing downloads until the user asks (#143)', () => {
    expect(DEFAULT_SETTINGS.speech).toEqual({
      engine: 'whisper',
      model: SPEECH_MODEL_NONE,
      language: 'auto',
      shortcut: 'Cmd+Alt'
    })
  })

  it('hasSpeechModel reads None as off and any id as on', () => {
    expect(hasSpeechModel(SPEECH_MODEL_NONE)).toBe(false)
    expect(hasSpeechModel('tiny')).toBe(true)
  })
})

const list = (...ids: Array<[string, boolean]>): ModelDownloadState[] =>
  ids.map(([id, downloaded]) => ({ id, downloaded }))

describe('modelAfterDownload', () => {
  it('adopts the first download — the default selection points at a model nobody fetched', () => {
    // `tiny` is selected out of the box (see the default above), so a user whose first download is
    // `base` was left pointed at a file that is not on disk, and dictation failed.
    expect(modelAfterDownload(list(['tiny', false], ['base', true]), 'tiny', 'base')).toBe('base')
  })

  it('leaves a working selection alone when a second model is tried out', () => {
    expect(modelAfterDownload(list(['tiny', true], ['small', true]), 'tiny', 'small')).toBeNull()
  })

  it('is a no-op when the selection is what was just downloaded', () => {
    expect(modelAfterDownload(list(['tiny', true]), 'tiny', 'tiny')).toBeNull()
  })

  it('adopts when the selected id is not in the catalogue at all', () => {
    // A removed/renamed model in an old settings file has nothing behind it either.
    expect(modelAfterDownload(list(['base', true]), 'ancient', 'base')).toBe('base')
  })

  it('adopts out of the None state — starting a download IS asking for dictation (#143)', () => {
    expect(modelAfterDownload(list(['base', true]), SPEECH_MODEL_NONE, 'base')).toBe('base')
  })
})

describe('modelAfterDelete', () => {
  it('falls back to another downloaded model when the selected one is deleted', () => {
    expect(modelAfterDelete(list(['tiny', false], ['small', true]), 'tiny')).toBe('small')
  })

  it('keeps the selection when it is still on disk', () => {
    expect(modelAfterDelete(list(['tiny', true], ['small', true]), 'tiny')).toBeNull()
  })

  it('answers null when nothing is downloaded — there is nothing truthful to select', () => {
    expect(modelAfterDelete(list(['tiny', false], ['small', false]), 'tiny')).toBeNull()
  })

  it('NEVER heals an explicit None — deleting a leftover model keeps dictation off (#143)', () => {
    // With None selected and another model still on disk, the old fallback would have re-adopted
    // it behind the user's back. An unset state is a legitimate value, not a dangling pointer.
    expect(modelAfterDelete(list(['tiny', true], ['small', true]), SPEECH_MODEL_NONE)).toBeNull()
  })
})
