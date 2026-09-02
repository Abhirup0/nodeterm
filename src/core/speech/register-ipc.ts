import { IPC } from '../../shared/ipc'
import { WHISPER_MODELS } from '../../shared/speech'
import type { Settings } from '../../shared/types'
import { cloudTranscribe } from './cloud-speech'
import { decodePcmPayload } from './pcm'
import type { SpeechService } from './speech-service'
import type { WhisperModelStore } from './whisper-models'

/** Registers the speech IPC surface. `handle` is the platform's
 * request/response seam — the same function works under Electron ipcMain and
 * the server's ws-rpc, which is what makes dictation a three-surface feature
 * for free. Mic consent is deliberately NOT here (Electron-only — the shells
 * register it themselves). */
export function registerSpeechIpc(deps: {
  handle: (channel: string, fn: (payload: any) => Promise<any>) => void
  service: SpeechService
  models: WhisperModelStore
  settings: () => Settings
  licenseToken: () => string | null
  apiBase: string
  fetchFn?: typeof fetch
}): void {
  deps.handle(IPC.speechTranscribe, async (payload: { pcm: ArrayBuffer | string; language?: string }) => {
    const speech = deps.settings().speech
    const pcm = decodePcmPayload(payload.pcm)
    const language = payload.language ?? speech.language
    const text = speech.engine === 'cloud'
      ? await cloudTranscribe(pcm, {
          apiBase: deps.apiBase,
          // The language goes to the endpoint UNCHANGED, `auto` included (issue #586). This used
          // to read `language === 'auto' ? 'en' : language`, which made "Auto-detect" a hard `en`
          // on cloud — silently, and for exactly the speakers auto-detect is there to serve. The
          // endpoint does not exist yet (every call 404s), so its contract is still ours to write:
          // `auto` means detect, and iOS sends the same field the same way.
          locale: language,
          token: deps.licenseToken(),
          fetchFn: deps.fetchFn,
        })
      : await deps.service.transcribe(pcm, { model: speech.model, language })
    return { text }
  })

  deps.handle(IPC.speechModels, async () => {
    const onDisk = await deps.models.list()
    return WHISPER_MODELS.map((m) => ({
      ...m,
      downloaded: onDisk.find((d) => d.id === m.id)?.downloaded ?? false,
      sizeMB: onDisk.find((d) => d.id === m.id)?.sizeMB,
    }))
  })

  deps.handle(IPC.speechModelDownload, async ({ id }: { id: string }) => { await deps.models.download(id) })
  deps.handle(IPC.speechModelDelete, async ({ id }: { id: string }) => { await deps.models.delete(id) })
}
