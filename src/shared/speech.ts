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

/** The download/selection state a surface needs to keep the two in step. Deliberately narrower
 *  than `SpeechModelInfo` so the mobile-shaped lists fit it too. */
export interface ModelDownloadState {
  id: string
  downloaded: boolean
}

/**
 * The model to select after `justDownloaded` finished, or null to leave the choice alone.
 *
 * Downloading is not selecting — but a settings default (`tiny`) means there is ALWAYS a
 * selection, so a user who downloads `base` first ends up pointed at a model that is not on disk
 * and dictation fails with "model not downloaded". They downloaded a model and reasonably believe
 * they are done. So: adopt the fresh download whenever the current selection has nothing behind
 * it, and never when it does — a working setup is not hijacked by trying a second model out.
 */
export function modelAfterDownload(
  models: readonly ModelDownloadState[],
  current: string,
  justDownloaded: string
): string | null {
  if (current === justDownloaded) return null
  // An id that is not in the list at all (a renamed/removed model) has nothing behind it either.
  return models.find((m) => m.id === current)?.downloaded ? null : justDownloaded
}

/**
 * The model to select after a delete, or null to leave it alone. Deleting the selected model
 * leaves the same dangling pointer a first download does — so fall back to whatever else is on
 * disk. Null when nothing is: there is nothing truthful to select, and the row list already says
 * so louder than a silent switch would.
 */
export function modelAfterDelete(
  models: readonly ModelDownloadState[],
  current: string
): string | null {
  if (models.find((m) => m.id === current)?.downloaded) return null
  return models.find((m) => m.downloaded)?.id ?? null
}
