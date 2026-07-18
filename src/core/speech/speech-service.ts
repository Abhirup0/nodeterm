import { whisperModel } from '../../shared/speech'
import type { WhisperModelStore } from './whisper-models'

export interface WhisperEngineHandle {
  transcribe(pcm: Float32Array, language: string): Promise<string>
  free(): Promise<void>
}

/** User-facing cause for a failed smart-whisper import. Pure — tested. */
export function describeWhisperLoadError(err: unknown): string {
  const code = (err as { code?: string })?.code
  const msg = err instanceof Error ? err.message : String(err)
  if (code === 'MODULE_NOT_FOUND' || code === 'ERR_MODULE_NOT_FOUND')
    return 'the smart-whisper module is not installed — run npm install'
  if (/NODE_MODULE_VERSION|was compiled against a different Node\.js version/.test(msg))
    return 'the native module was built for a different runtime — run npm run rebuild'
  return msg
}

/** Local dictation via whisper.cpp (smart-whisper). One loaded model at a
 * time (they are hundreds of MB of RAM); same-model loads dedupe onto one
 * in-flight promise; transcriptions run FIFO on a promise chain. The Pro
 * rule (non-tiny needs premium) is validated HERE, not only in the UI, so a
 * bypassed renderer lock still can't use a paid model. */
export class SpeechService {
  private readonly models: WhisperModelStore
  private readonly isPremium: () => boolean
  private readonly engineFactory: (modelPath: string) => Promise<WhisperEngineHandle>
  private loaded: { path: string; engine: Promise<WhisperEngineHandle> } | null = null
  private queue: Promise<unknown> = Promise.resolve()

  constructor(opts: {
    models: WhisperModelStore
    isPremium: () => boolean
    engineFactory?: (modelPath: string) => Promise<WhisperEngineHandle>
  }) {
    this.models = opts.models
    this.isPremium = opts.isPremium
    this.engineFactory = opts.engineFactory ?? defaultEngineFactory
  }

  transcribe(pcm: Float32Array, opts: { model: string; language: string }): Promise<string> {
    const run = this.queue.then(() => this.transcribeNow(pcm, opts))
    // FIFO: the next caller waits for this one, success or failure.
    this.queue = run.catch(() => {})
    return run
  }

  private async transcribeNow(pcm: Float32Array, opts: { model: string; language: string }): Promise<string> {
    const info = whisperModel(opts.model)
    if (!info) throw new Error(`Unknown whisper model: ${opts.model}`)
    if (info.pro && !this.isPremium()) {
      throw new Error(`The ${info.id} model requires nodeterm Pro — the tiny model is free.`)
    }
    if (!(await this.models.has(info.id))) {
      throw new Error(`Download the ${info.id} model in Settings → Speech first.`)
    }
    const path = this.models.modelPath(info.id)
    if (this.loaded && this.loaded.path !== path) {
      const old = this.loaded
      this.loaded = null
      await old.engine.then((e) => e.free()).catch(() => {})
    }
    if (!this.loaded) {
      const engine = this.engineFactory(path)
      this.loaded = { path, engine }
      engine.catch(() => { if (this.loaded?.engine === engine) this.loaded = null })
    }
    const engine = await this.loaded.engine
    const text = (await engine.transcribe(pcm, opts.language)).trim()
    if (!text) throw new Error('No speech detected.')
    return text
  }
}

async function defaultEngineFactory(modelPath: string): Promise<WhisperEngineHandle> {
  let mod: any
  try {
    // @ts-ignore -- optional native dep: absent until installed, and @ts-ignore stays valid either way (an expect-error would break the build the moment it resolves)
    mod = await import('smart-whisper')
  } catch (err) {
    console.error('[speech] smart-whisper failed to load:', err)
    throw new Error(
      `Local whisper is unavailable (${describeWhisperLoadError(err)}). Try the Cloud engine.`,
    )
  }
  const whisper = new mod.Whisper(modelPath, { gpu: true })
  return {
    async transcribe(pcm, language) {
      const task = await whisper.transcribe(pcm, { language: language === 'auto' ? 'auto' : language })
      const result = await task.result
      return (Array.isArray(result) ? result.map((r: any) => r.text).join(' ') : String(result ?? '')).trim()
    },
    async free() {
      await whisper.free()
    },
  }
}
