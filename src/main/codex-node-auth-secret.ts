import { randomBytes } from 'crypto'
import { promises as fs } from 'fs'
import path from 'path'
import { app, safeStorage } from 'electron'

type StoredSecret = { version: 1; secretKeyEnc: string }

let cached: Promise<Buffer> | null = null
let cachedFile = ''

function secretFile(): string {
  return path.join(app.getPath('userData'), 'codex-node-auth-key.json')
}

function decode(raw: string): Buffer {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error('OS keychain is unavailable')
  }
  let stored: StoredSecret
  try {
    stored = JSON.parse(raw) as StoredSecret
  } catch {
    throw new Error('Codex node-auth key is malformed')
  }
  if (stored?.version !== 1 || typeof stored.secretKeyEnc !== 'string') {
    throw new Error('Codex node-auth key is malformed')
  }
  const secret = Buffer.from(safeStorage.decryptString(Buffer.from(stored.secretKeyEnc, 'base64')), 'base64')
  if (secret.byteLength !== 32) throw new Error('Codex node-auth key is invalid')
  return secret
}

async function persist(file: string, secret: Buffer): Promise<void> {
  if (!safeStorage.isEncryptionAvailable()) throw new Error('OS keychain is unavailable')
  const body: StoredSecret = {
    version: 1,
    secretKeyEnc: safeStorage.encryptString(secret.toString('base64')).toString('base64')
  }
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  await fs.mkdir(path.dirname(file), { recursive: true })
  try {
    await fs.writeFile(tmp, `${JSON.stringify(body)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx'
    })
    await fs.rename(tmp, file)
    await fs.chmod(file, 0o600)
  } finally {
    await fs.unlink(tmp).catch(() => {})
  }
}

async function load(file: string): Promise<Buffer> {
  try {
    return decode(await fs.readFile(file, 'utf8'))
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }
  const secret = randomBytes(32)
  await persist(file, secret)
  return secret
}

/** Restart-stable node-capability key. Ciphertext only at rest; no plaintext fallback. */
export function loadOrCreateCodexNodeAuthSecret(): Promise<Buffer> {
  const file = secretFile()
  if (cached && cachedFile === file) return cached
  const pending = load(file)
  cached = pending
  cachedFile = file
  pending.catch(() => {
    if (cached === pending) {
      cached = null
      cachedFile = ''
    }
  })
  return pending
}

export function resetCodexNodeAuthSecretForTests(): void {
  cached = null
  cachedFile = ''
}
