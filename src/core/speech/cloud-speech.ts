import { randomUUID } from 'node:crypto'
import { pcmToWav } from './pcm'

/** Cloud dictation against the nodeterm backend — the SAME wire contract the
 * iOS Cloud engine speaks (multipart WAV + locale, Bearer license token), so
 * the one future /v1/transcribe endpoint serves both platforms. Until it
 * exists, every call maps 404 to a friendly "not available yet". */
export function buildTranscribeRequest(opts: {
  apiBase: string
  wav: Uint8Array
  locale: string
  token: string | null
  boundary?: string
}): { url: string; init: RequestInit } {
  const boundary = opts.boundary ?? randomUUID()
  const headers: Record<string, string> = {
    'Content-Type': `multipart/form-data; boundary=${boundary}`,
  }
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`
  const enc = (s: string) => Buffer.from(s, 'latin1')
  const body = Buffer.concat([
    enc(`--${boundary}\r\nContent-Disposition: form-data; name="locale"\r\n\r\n${opts.locale}\r\n`),
    enc(`--${boundary}\r\nContent-Disposition: form-data; name="audio"; filename="dictation.wav"\r\nContent-Type: audio/wav\r\n\r\n`),
    Buffer.from(opts.wav),
    enc(`\r\n--${boundary}--\r\n`),
  ])
  return { url: `${opts.apiBase}/v1/transcribe`, init: { method: 'POST', headers, body } }
}

export async function cloudTranscribe(
  pcm: Float32Array,
  opts: { apiBase: string; locale: string; token: string | null; fetchFn?: typeof fetch },
): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch
  const { url, init } = buildTranscribeRequest({
    apiBase: opts.apiBase, wav: pcmToWav(pcm), locale: opts.locale, token: opts.token,
  })
  const res = await fetchFn(url, init)
  if (res.status === 404) throw new Error("Cloud transcription isn't available yet.")
  if (res.status !== 200) {
    const body = await res.json().catch(() => null) as { error?: string } | null
    throw new Error(body?.error ?? `Cloud transcription failed (${res.status}).`)
  }
  const body = await res.json().catch(() => null) as { text?: string } | null
  if (typeof body?.text !== 'string') throw new Error('Cloud transcription returned an unexpected response.')
  return body.text.trim()
}
