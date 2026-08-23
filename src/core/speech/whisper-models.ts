import { createWriteStream } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { renameAtomic } from '../fs-atomic'
import { Writable } from 'node:stream'
import { WHISPER_DOWNLOAD_BASE, WHISPER_MODELS, whisperModel } from '../../shared/speech'

/** Downloads and manages the local ggml whisper models. The fences here are
 * lessons already paid for on iOS: a download streams to a per-download `<file>.part.<genId>`
 * and renames only on completion; delete() aborts an in-flight download and a
 * late chunk can never resurrect a deleted model; concurrent download() of
 * the same id joins the same promise instead of racing two writers. */
export class WhisperModelStore {
  private readonly dir: string
  private readonly fetchFn: typeof fetch
  private readonly onProgress?: (id: string, pct: number) => void
  private readonly inFlight = new Map<string, { promise: Promise<void>; abort: AbortController }>()

  constructor(opts: { dir: string; fetchFn?: typeof fetch; onProgress?: (id: string, pct: number) => void }) {
    this.dir = opts.dir
    this.fetchFn = opts.fetchFn ?? fetch
    this.onProgress = opts.onProgress
  }

  modelPath(id: string): string {
    const info = whisperModel(id)
    return join(this.dir, info ? info.file : `${id}.bin`)
  }

  async has(id: string): Promise<boolean> {
    try { await stat(this.modelPath(id)); return true } catch { return false }
  }

  async list(): Promise<Array<{ id: string; downloaded: boolean; sizeMB?: number }>> {
    const out: Array<{ id: string; downloaded: boolean; sizeMB?: number }> = []
    for (const m of WHISPER_MODELS) {
      try {
        const s = await stat(this.modelPath(m.id))
        out.push({ id: m.id, downloaded: true, sizeMB: Math.round(s.size / 1_000_000) })
      } catch {
        out.push({ id: m.id, downloaded: false })
      }
    }
    return out
  }

  download(id: string): Promise<void> {
    const existing = this.inFlight.get(id)
    if (existing) return existing.promise
    const info = whisperModel(id)
    if (!info) return Promise.reject(new Error(`unknown whisper model: ${id}`))
    const abort = new AbortController()
    // Math.random suffices: not a security boundary, just a scratch-name de-collider.
    const genId = Math.random().toString(36).slice(2)
    const promise = this.run(id, info.file, abort, genId).finally(() => {
      // Only clear our own slot — a delete already removed it.
      if (this.inFlight.get(id)?.abort === abort) this.inFlight.delete(id)
    })
    this.inFlight.set(id, { promise, abort })
    return promise
  }

  /** Remove every .part.<genId> variant for this id. Part names are
   * per-download (see run()), so a hard crash can strand orphans that no
   * deterministic rm would ever find — sweep by prefix instead. */
  private async removeParts(id: string): Promise<void> {
    const base = this.modelPath(id)
    const prefix = `${base.split('/').pop()}.part`
    const entries = await readdir(this.dir).catch(() => [] as string[])
    await Promise.all(
      entries.filter((e) => e.startsWith(prefix)).map((e) => rm(join(this.dir, e), { force: true })),
    )
  }

  private async run(id: string, file: string, abort: AbortController, genId: string): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    // Sweep stale .part.<*> orphans before creating the new part file. The
    // in-flight dedupe guarantees no OTHER live writer for this id exists, so
    // we can only ever remove abandoned fragments from prior hard crashes.
    if (this.inFlight.get(id)?.abort === abort) {
      await this.removeParts(id)
    }
    const partPath = this.modelPath(id) + '.part.' + genId
    const res = await this.fetchFn(WHISPER_DOWNLOAD_BASE + file, { signal: abort.signal })
    if (!res.ok || !res.body) throw new Error(`model download failed (${res.status})`)
    const total = Number(res.headers.get('content-length')) || 0
    let received = 0
    const sink = createWriteStream(partPath)
    try {
      const reader = res.body.getReader()
      const writer = Writable.toWeb(sink).getWriter()
      for (;;) {
        const { done, value } = await reader.read()
        if (abort.signal.aborted) throw new Error('download cancelled')
        if (done) break
        await writer.write(value)
        received += value.byteLength
        if (total) this.onProgress?.(id, Math.min(99, Math.round((received / total) * 100)))
      }
      await writer.close()
      if (abort.signal.aborted) throw new Error('download cancelled')
      await renameAtomic(partPath, this.modelPath(id))
      this.onProgress?.(id, 100)
    } catch (err) {
      sink.destroy()
      await rm(partPath, { force: true })
      throw err
    }
  }

  async delete(id: string): Promise<void> {
    // modelPath() falls back to `${id}.bin` for an unrecognized id — reachable here (and via
    // has()) — so an unvalidated id let the authed delete IPC (register-ipc.ts) rm an arbitrary
    // path under this.dir, e.g. `../../etc/passwd`. Reject up front, same as download() already
    // does via whisperModel().
    if (!whisperModel(id)) throw new Error(`unknown whisper model: ${id}`)
    const inFlight = this.inFlight.get(id)
    if (inFlight) {
      this.inFlight.delete(id)
      inFlight.abort.abort()
      await inFlight.promise.catch(() => {}) // wait out the writer's cleanup
    }
    // A new download may have started while we awaited the old one's
    // cleanup — its .part is live; removing files now would yank them out
    // from under the new writer. The delete's intent (kill the OLD download,
    // remove the OLD files) is already done: the abort's error path removed
    // the old .part, and no completed file can exist mid-download.
    if (this.inFlight.has(id)) return
    await rm(this.modelPath(id), { force: true })
    await this.removeParts(id)
  }
}
