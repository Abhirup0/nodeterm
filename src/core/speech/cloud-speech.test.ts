import { describe, expect, it } from 'vitest'
import { buildTranscribeRequest, cloudTranscribe } from './cloud-speech'

const wav = new Uint8Array([0x52, 0x49, 0x46, 0x46]) // "RIFF"

describe('buildTranscribeRequest', () => {
  it('builds the exact multipart body the iOS contract pins', () => {
    const { url, init } = buildTranscribeRequest({
      apiBase: 'https://api.example.dev', wav, locale: 'tr-TR', token: 'tok.sig', boundary: 'BOUNDARY',
    })
    expect(url).toBe('https://api.example.dev/v1/transcribe')
    expect(init.method).toBe('POST')
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer tok.sig')
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('multipart/form-data; boundary=BOUNDARY')
    const body = Buffer.from(init.body as Uint8Array).toString('latin1')
    expect(body).toBe(
      '--BOUNDARY\r\nContent-Disposition: form-data; name="locale"\r\n\r\ntr-TR\r\n' +
      '--BOUNDARY\r\nContent-Disposition: form-data; name="audio"; filename="dictation.wav"\r\n' +
      'Content-Type: audio/wav\r\n\r\nRIFF\r\n--BOUNDARY--\r\n',
    )
  })

  it('omits Authorization without a token', () => {
    const { init } = buildTranscribeRequest({ apiBase: 'x', wav, locale: 'en', token: null })
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined()
  })
})

describe('cloudTranscribe', () => {
  const pcm = new Float32Array(160)
  const respond = (status: number, body: unknown): typeof fetch =>
    (async () => ({ ok: status === 200, status, json: async () => body }) as unknown as Response) as typeof fetch

  it('maps 404 to the not-available message', async () => {
    await expect(cloudTranscribe(pcm, { apiBase: 'x', locale: 'en', token: null, fetchFn: respond(404, {}) }))
      .rejects.toThrow("Cloud transcription isn't available yet.")
  })

  it('surfaces the server error field', async () => {
    await expect(cloudTranscribe(pcm, { apiBase: 'x', locale: 'en', token: 't', fetchFn: respond(429, { error: 'rate limited' }) }))
      .rejects.toThrow('rate limited')
  })

  it('returns trimmed text on 200', async () => {
    await expect(cloudTranscribe(pcm, { apiBase: 'x', locale: 'en', token: 't', fetchFn: respond(200, { text: ' hi ' }) }))
      .resolves.toBe('hi')
  })
})
