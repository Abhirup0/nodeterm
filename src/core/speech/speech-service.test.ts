import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SpeechService, type WhisperEngineHandle } from './speech-service'
import { WhisperModelStore } from './whisper-models'

describe('SpeechService', () => {
  let dir: string
  let models: WhisperModelStore
  const loads: string[] = []
  const freed: string[] = []

  function factory(result = 'hello world'): (p: string) => Promise<WhisperEngineHandle> {
    return async (modelPath: string) => {
      loads.push(modelPath)
      return {
        transcribe: vi.fn(async () => result),
        free: vi.fn(async () => { freed.push(modelPath) }),
      }
    }
  }
  const pcm = new Float32Array(16000)

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'svc-'))
    models = new WhisperModelStore({ dir })
    loads.length = 0
    freed.length = 0
    writeFileSync(models.modelPath('tiny'), 'x') // "downloaded"
    writeFileSync(models.modelPath('base'), 'x')
  })

  it('transcribes with a free model without premium', async () => {
    const svc = new SpeechService({ models, isPremium: () => false, engineFactory: factory() })
    await expect(svc.transcribe(pcm, { model: 'tiny', language: 'auto' })).resolves.toBe('hello world')
  })

  it('rejects a Pro model without premium — core-side gate', async () => {
    const svc = new SpeechService({ models, isPremium: () => false, engineFactory: factory() })
    await expect(svc.transcribe(pcm, { model: 'base', language: 'auto' }))
      .rejects.toThrow(/requires nodeterm Pro/)
    expect(loads).toHaveLength(0) // never even loads the model
  })

  it('allows Pro models with premium', async () => {
    const svc = new SpeechService({ models, isPremium: () => true, engineFactory: factory() })
    await expect(svc.transcribe(pcm, { model: 'base', language: 'auto' })).resolves.toBe('hello world')
  })

  it('errors when the model is not downloaded', async () => {
    const svc = new SpeechService({ models, isPremium: () => true, engineFactory: factory() })
    await expect(svc.transcribe(pcm, { model: 'small', language: 'auto' }))
      .rejects.toThrow(/Download the/)
  })

  it('reuses one loaded engine and frees it on model switch', async () => {
    const svc = new SpeechService({ models, isPremium: () => true, engineFactory: factory() })
    await svc.transcribe(pcm, { model: 'tiny', language: 'auto' })
    await svc.transcribe(pcm, { model: 'tiny', language: 'auto' })
    expect(loads).toHaveLength(1)
    await svc.transcribe(pcm, { model: 'base', language: 'auto' })
    expect(loads).toHaveLength(2)
    expect(freed).toEqual([models.modelPath('tiny')])
  })

  it('maps an empty transcript to "No speech detected."', async () => {
    const svc = new SpeechService({ models, isPremium: () => true, engineFactory: factory('   ') })
    await expect(svc.transcribe(pcm, { model: 'tiny', language: 'auto' }))
      .rejects.toThrow('No speech detected.')
  })
})
