// scrypt (built-in) instead of the spec's argon2 — no native dependency; parameters N=16384,r=8,p=1 per OWASP baseline.
import crypto from 'crypto'
import fs from 'fs'
import path from 'path'

const SCRYPT_N = 16384
const SCRYPT_R = 8
const SCRYPT_P = 1
const SCRYPT_KEYLEN = 32

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const LOCKOUT_MS = 60_000
const MAX_FAILURES = 5

interface AuthFile {
  salt: string
  hash: string
  N: number
  r: number
  p: number
}

interface SessionEntry {
  createdAt: number
}

type SessionMap = { [token: string]: SessionEntry }

export class Auth {
  private authPath: string
  private sessionsPath: string

  private setupTokenValue: string | null = null

  private sessions: SessionMap | null = null

  private failures = 0
  private lockedUntil = 0

  constructor(dataDir: string) {
    this.authPath = path.join(dataDir, 'auth.json')
    this.sessionsPath = path.join(dataDir, 'sessions.json')
  }

  // ---- Configuration / password ------------------------------------------

  isConfigured(): boolean {
    return fs.existsSync(this.authPath)
  }

  private readAuth(): AuthFile | null {
    try {
      return JSON.parse(fs.readFileSync(this.authPath, 'utf8')) as AuthFile
    } catch {
      return null
    }
  }

  setPassword(password: string): void {
    const salt = crypto.randomBytes(16)
    const hash = crypto.scryptSync(password, salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P
    })
    const data: AuthFile = {
      salt: salt.toString('hex'),
      hash: hash.toString('hex'),
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P
    }
    fs.writeFileSync(this.authPath, JSON.stringify(data, null, 2), { mode: 0o600 })
  }

  verifyPassword(password: string): boolean {
    const auth = this.readAuth()
    if (!auth) return false
    const salt = Buffer.from(auth.salt, 'hex')
    const stored = Buffer.from(auth.hash, 'hex')
    const computed = crypto.scryptSync(password, salt, stored.length, {
      N: auth.N,
      r: auth.r,
      p: auth.p
    })
    if (computed.length !== stored.length) return false
    return crypto.timingSafeEqual(computed, stored)
  }

  // ---- Setup token -------------------------------------------------------

  setupToken(): string {
    if (this.setupTokenValue === null) {
      this.setupTokenValue = crypto.randomBytes(16).toString('hex') // 32 hex chars
    }
    return this.setupTokenValue
  }

  consumeSetupToken(candidate: string): boolean {
    const current = this.setupTokenValue
    if (current === null) return false
    const a = crypto.createHash('sha256').update(candidate).digest()
    const b = crypto.createHash('sha256').update(current).digest()
    if (!crypto.timingSafeEqual(a, b)) return false
    this.setupTokenValue = null
    return true
  }

  // ---- Sessions ----------------------------------------------------------

  private loadSessions(): SessionMap {
    if (this.sessions === null) {
      try {
        this.sessions = JSON.parse(fs.readFileSync(this.sessionsPath, 'utf8')) as SessionMap
      } catch {
        this.sessions = {}
      }
    }
    return this.sessions
  }

  private persistSessions(): void {
    fs.writeFileSync(this.sessionsPath, JSON.stringify(this.sessions ?? {}, null, 2), {
      mode: 0o600
    })
  }

  createSession(): string {
    const sessions = this.loadSessions()
    const token = crypto.randomBytes(32).toString('hex')
    sessions[token] = { createdAt: Date.now() }
    this.persistSessions()
    return token
  }

  validateSession(token: string | undefined): boolean {
    if (!token) return false
    const sessions = this.loadSessions()
    const now = Date.now()
    let changed = false
    for (const [t, entry] of Object.entries(sessions)) {
      if (now - entry.createdAt >= SESSION_TTL_MS) {
        delete sessions[t]
        changed = true
      }
    }
    if (changed) this.persistSessions()
    return Object.prototype.hasOwnProperty.call(sessions, token)
  }

  revokeAll(): void {
    this.sessions = {}
    this.persistSessions()
  }

  // ---- Rate limiting -----------------------------------------------------

  loginAllowed(): boolean {
    return Date.now() >= this.lockedUntil
  }

  recordLoginFailure(): void {
    this.failures += 1
    if (this.failures >= MAX_FAILURES) {
      this.lockedUntil = Date.now() + LOCKOUT_MS
      this.failures = 0
    }
  }

  recordLoginSuccess(): void {
    this.failures = 0
    this.lockedUntil = 0
  }
}
