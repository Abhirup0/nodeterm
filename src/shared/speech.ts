/** Downloadable whisper.cpp models (ggml files on HuggingFace). `pro` marks
 * the paid tier — tiny stays free (the desktop mirror of mobile's split). */
export interface WhisperModelInfo {
  id: string
  file: string
  approxMB: number
  pro: boolean
}

export const WHISPER_MODELS: WhisperModelInfo[] = [
  { id: 'tiny', file: 'ggml-tiny.bin', approxMB: 75, pro: false },
  { id: 'base', file: 'ggml-base.bin', approxMB: 142, pro: true },
  { id: 'small', file: 'ggml-small.bin', approxMB: 466, pro: true },
  { id: 'large-v3-turbo', file: 'ggml-large-v3-turbo.bin', approxMB: 1600, pro: true },
]

export const WHISPER_DOWNLOAD_BASE = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/'

export function whisperModel(id: string): WhisperModelInfo | undefined {
  return WHISPER_MODELS.find((m) => m.id === id)
}
