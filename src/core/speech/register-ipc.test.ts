import { describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerSpeechIpc } from './register-ipc'
import { SpeechService, type WhisperEngineHandle } from './speech-service'
import { WhisperModelStore } from './whisper-models'
import { DEFAULT_SETTINGS } from '../../shared/types'

function setup(engine: 'whisper' | 'cloud' = 'whisper') {
  const handlers = new Map<string, (payload: any) => Promise<any>>()
  const dir = mkdtempSync(join(tmpdir(), 'ipc-'))
  const models = new WhisperModelStore({ dir })
  writeFileSync(models.modelPath('tiny'), 'x')
  const factory = async (): Promise<WhisperEngineHandle> => ({
    transcribe: async () => 'from whisper', free: async () => {},
  })
  const service = new SpeechService({ models, isPremium: () => false, engineFactory: factory })
  registerSpeechIpc({
    handle: (ch, fn) => handlers.set(ch, fn),
    service, models,
    settings: () => ({ ...DEFAULT_SETTINGS, speech: { engine, model: 'tiny', language: 'auto' } }),
    licenseToken: () => null,
    apiBase: 'https://api.example.dev',
    fetchFn: (async () => ({ ok: false, status: 404, json: async () => ({}) })) as any,
  })
  return { handlers }
}

describe('registerSpeechIpc', () => {
  it('routes transcribe to whisper and accepts an ArrayBuffer payload', async () => {
    const { handlers } = setup('whisper')
    const pcm = new Float32Array(16).buffer
    await expect(handlers.get('speech:transcribe')!({ pcm })).resolves.toEqual({ text: 'from whisper' })
  })

  it('routes transcribe to cloud when configured (and surfaces its 404 message)', async () => {
    const { handlers } = setup('cloud')
    await expect(handlers.get('speech:transcribe')!({ pcm: new Float32Array(16).buffer }))
      .rejects.toThrow("Cloud transcription isn't available yet.")
  })

  it('lists models merged with catalog metadata', async () => {
    const { handlers } = setup()
    const list = await handlers.get('speech:models')!({})
    expect(list.find((m: any) => m.id === 'tiny')).toMatchObject({ downloaded: true, pro: false, approxMB: 75 })
    expect(list.find((m: any) => m.id === 'base')).toMatchObject({ downloaded: false, pro: true })
  })
})
