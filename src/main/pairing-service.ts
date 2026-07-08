// Phone-pairing service (main process) — the host side of the nodeterm iOS "scan a QR" flow.
//
// start() mints a one-time token, opens a single-shot LAN HTTP listener on a random port, and
// returns the JSON payload (for the renderer to render as a QR) plus whether SSH looks reachable.
// The phone scans the QR, generates an Ed25519 keypair on-device, and POSTs {token, publicKey}
// to http://<host>:<pairPort>/pair. On a token match we append the key to ~/.ssh/authorized_keys
// and stop the listener. The private key never leaves the phone; the only secret in the QR is the
// single-use token.
//
// Pure bits (payload build, key validation, LAN-IPv4 pick) live in `pairing-core.ts` so they're
// unit-tested without spinning up a server.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'http'
import { connect as netConnect } from 'net'
import { randomBytes, randomUUID } from 'crypto'
import { promises as fs } from 'fs'
import { execFile } from 'child_process'
import { promisify } from 'util'
import os from 'os'
import path from 'path'
import {
  buildPairingPayload,
  filterAuthorizedKeys,
  isValidEd25519PublicKey,
  normalizeAuthorizedKeysLine,
  normalizeDeviceName,
  pickLanIPv4,
  readDevices,
  removeDevice,
  rewriteKeyComment,
  toPublicDevices,
  upsertDevice,
  type DeviceEntry,
  type PublicDevice
} from './pairing-core'

const execFileAsync = promisify(execFile)

/** How long the listener waits for the phone before giving up. */
const PAIR_TIMEOUT_MS = 2 * 60 * 1000
/** Probe timeout for the "is sshd listening on :22?" check. */
const SSH_PROBE_MS = 500
/** Reject oversized POST bodies (a public key line is well under this). */
const MAX_BODY_BYTES = 64 * 1024

export interface PairingStartResult {
  /** The single-line JSON to encode into the QR. */
  payload: string
  /** True when 127.0.0.1:22 accepted a connection — sshd is (probably) running. */
  sshOpen: boolean
}

/** Fired once when pairing finishes: ok=true → a key was installed, ok=false → timeout/cancel. */
export type PairingDone = { ok: boolean }

export interface PairingService {
  /** Begin pairing; resolves once the listener is up. `onDone` fires exactly once later. */
  start(onDone: (result: PairingDone) => void): Promise<PairingStartResult>
  /** Cancel an in-flight pairing (idempotent). Does NOT fire onDone. */
  stop(): void
  /** All paired devices (token stripped) from ~/.nodeterm/agent.json. */
  listDevices(): Promise<PublicDevice[]>
  /** Revoke a device: drop its agent.json entry AND delete its authorized_keys line. */
  revokeDevice(id: string): Promise<void>
}

/** ~/.nodeterm holds the host-agent config (agent.json). Created 0700 if missing. */
const AGENT_DIR = path.join(os.homedir(), '.nodeterm')
const AGENT_JSON_PATH = path.join(AGENT_DIR, 'agent.json')
const AUTH_KEYS_PATH = path.join(os.homedir(), '.ssh', 'authorized_keys')

/** Read + parse ~/.nodeterm/agent.json; returns {} when absent or malformed. */
async function readAgentJson(): Promise<Record<string, unknown>> {
  try {
    const parsed = JSON.parse(await fs.readFile(AGENT_JSON_PATH, 'utf8'))
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

/** Write agent.json atomically (0600), creating ~/.nodeterm (0700) if needed. */
async function writeAgentJson(obj: Record<string, unknown>): Promise<void> {
  await fs.mkdir(AGENT_DIR, { recursive: true, mode: 0o700 })
  await fs.chmod(AGENT_DIR, 0o700).catch(() => {})
  const tmp = `${AGENT_JSON_PATH}.tmp`
  await fs.writeFile(tmp, JSON.stringify(obj, null, 2) + '\n', { mode: 0o600 })
  await fs.chmod(tmp, 0o600).catch(() => {})
  await fs.rename(tmp, AGENT_JSON_PATH)
  await fs.chmod(AGENT_JSON_PATH, 0o600).catch(() => {})
}

/** Persist a device into agent.json, preserving all other fields the host agent wrote. */
async function persistDevice(entry: DeviceEntry): Promise<void> {
  const obj = await readAgentJson()
  const devices = upsertDevice(readDevices(obj), entry)
  await writeAgentJson({ ...obj, devices })
}

/** Detect the machine's display name (macOS ComputerName, else hostname). */
async function computerName(): Promise<string> {
  if (process.platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('scutil', ['--get', 'ComputerName'])
      const name = stdout.trim()
      if (name) return name
    } catch {
      // fall through to hostname
    }
  }
  return os.hostname()
}

/** Quick TCP probe of 127.0.0.1:22 to guess whether Remote Login (sshd) is on. */
function probeSsh(): Promise<boolean> {
  return new Promise((resolve) => {
    let done = false
    const finish = (open: boolean): void => {
      if (done) return
      done = true
      try {
        sock.destroy()
      } catch {
        // ignore
      }
      resolve(open)
    }
    const sock = netConnect({ host: '127.0.0.1', port: 22 })
    sock.setTimeout(SSH_PROBE_MS)
    sock.once('connect', () => finish(true))
    sock.once('timeout', () => finish(false))
    sock.once('error', () => finish(false))
  })
}

/**
 * Append an already-normalized public-key line to ~/.ssh/authorized_keys with the right
 * permissions. The caller stamps the attributable `nodeterm-ios-<deviceId>` comment via
 * `rewriteKeyComment` before this point.
 */
async function appendAuthorizedKey(keyLine: string): Promise<void> {
  const sshDir = path.join(os.homedir(), '.ssh')
  await fs.mkdir(sshDir, { recursive: true, mode: 0o700 })
  await fs.chmod(sshDir, 0o700).catch(() => {})
  // Guard against a file that doesn't end in a newline (would concatenate onto the last key).
  let prefix = ''
  try {
    const existing = await fs.readFile(AUTH_KEYS_PATH, 'utf8')
    if (existing.length > 0 && !existing.endsWith('\n')) prefix = '\n'
  } catch {
    // no file yet — appendFile creates it
  }
  await fs.appendFile(AUTH_KEYS_PATH, prefix + normalizeAuthorizedKeysLine(keyLine) + '\n')
  await fs.chmod(AUTH_KEYS_PATH, 0o600)
}

/** Delete every authorized_keys line stamped for `deviceId`, rewriting the file atomically (0600). */
async function removeAuthorizedKeysForDevice(deviceId: string): Promise<void> {
  let content: string
  try {
    content = await fs.readFile(AUTH_KEYS_PATH, 'utf8')
  } catch {
    return // no file → nothing to revoke
  }
  const next = filterAuthorizedKeys(content, deviceId)
  if (next === content) return
  const tmp = `${AUTH_KEYS_PATH}.tmp`
  await fs.writeFile(tmp, next, { mode: 0o600 })
  await fs.chmod(tmp, 0o600).catch(() => {})
  await fs.rename(tmp, AUTH_KEYS_PATH)
  await fs.chmod(AUTH_KEYS_PATH, 0o600).catch(() => {})
}

/** Read the whole request body (capped), rejecting oversized payloads. */
function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (c: Buffer) => {
      size += c.length
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(c)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function createPairingService(): PairingService {
  let server: Server | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let onDoneCb: ((result: PairingDone) => void) | null = null

  const cleanup = (): void => {
    if (timer) {
      clearTimeout(timer)
      timer = null
    }
    if (server) {
      server.close()
      server = null
    }
  }

  // Fire the completion callback exactly once, then tear everything down.
  const finish = (result: PairingDone): void => {
    const cb = onDoneCb
    onDoneCb = null
    cleanup()
    cb?.(result)
  }

  const start = async (onDone: (result: PairingDone) => void): Promise<PairingStartResult> => {
    // A prior in-flight pairing is cancelled silently (no onDone) before starting a new one.
    onDoneCb = null
    cleanup()
    onDoneCb = onDone

    const host = pickLanIPv4(os.networkInterfaces())
    if (!host) {
      onDoneCb = null
      throw new Error("Couldn't detect a LAN IP address — connect to Wi-Fi and try again.")
    }
    const token = randomBytes(24).toString('base64url')
    const user = os.userInfo().username

    const srv = createServer((req: IncomingMessage, res: ServerResponse) => {
      void handleRequest(req, res)
    })
    server = srv

    // Bind a random high port on all interfaces (0.0.0.0) so the phone on the LAN can reach it.
    await new Promise<void>((resolve, reject) => {
      srv.once('error', reject)
      srv.listen(0, '0.0.0.0', () => {
        srv.removeListener('error', reject)
        resolve()
      })
    })

    const addr = srv.address()
    const pairPort = typeof addr === 'object' && addr ? addr.port : 0
    const [name, sshOpen] = await Promise.all([computerName(), probeSsh()])
    const payload = buildPairingPayload({ host, port: 22, user, token, pairPort, name })

    // Give up after 2 minutes with a timeout result.
    timer = setTimeout(() => finish({ ok: false }), PAIR_TIMEOUT_MS)
    timer.unref?.()

    async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
      if (req.method !== 'POST' || req.url !== '/pair') {
        res.writeHead(404).end()
        return
      }
      try {
        const raw = await readBody(req)
        let body: { token?: unknown; publicKey?: unknown; deviceName?: unknown }
        try {
          body = JSON.parse(raw)
        } catch {
          res.writeHead(400).end('bad json')
          return
        }
        if (body.token !== token) {
          res.writeHead(403).end('bad token')
          return
        }
        const publicKey = typeof body.publicKey === 'string' ? body.publicKey.trim() : ''
        if (!isValidEd25519PublicKey(publicKey)) {
          res.writeHead(400).end('unexpected key type')
          return
        }
        // Mint a device identity: the deviceId stamps the key line (attributable + revocable);
        // the agentToken is the phone's bearer for the host-agent WebSocket (stored in its Keychain).
        const deviceId = randomUUID()
        const agentToken = randomBytes(24).toString('base64url')
        const name = normalizeDeviceName(body.deviceName)
        await appendAuthorizedKey(rewriteKeyComment(publicKey, deviceId))
        await persistDevice({
          id: deviceId,
          name,
          token: agentToken,
          pairedAt: Date.now(),
          lastSeenAt: 0
        })
        res
          .writeHead(200, { 'Content-Type': 'application/json' })
          .end(JSON.stringify({ ok: true, deviceId, agentToken }))
        finish({ ok: true })
      } catch (err) {
        res.writeHead(500).end('pairing failed')
        console.warn('[pairing] request failed:', err)
      }
    }

    return { payload, sshOpen }
  }

  const stop = (): void => {
    onDoneCb = null
    cleanup()
  }

  const listDevices = async (): Promise<PublicDevice[]> => {
    return toPublicDevices(readDevices(await readAgentJson()))
  }

  const revokeDevice = async (id: string): Promise<void> => {
    const obj = await readAgentJson()
    const devices = removeDevice(readDevices(obj), id)
    await writeAgentJson({ ...obj, devices })
    await removeAuthorizedKeysForDevice(id)
  }

  return { start, stop, listDevices, revokeDevice }
}
