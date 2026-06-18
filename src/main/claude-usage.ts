// Fetches Claude Code subscription usage (session + weekly) from Anthropic's OAuth usage
// endpoint. Runs in the main process (Node) so the renderer CSP stays 'self' — the renderer
// asks for the data over IPC. Display-only: we never write credentials or refresh tokens.
import { promises as fs } from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { ipcMain, type BrowserWindow } from 'electron'
import { IPC } from '../shared/ipc'
import type { ClaudeUsage, ClaudeUsageWindow } from '../shared/types'

const execFileP = promisify(execFile)

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const OAUTH_BETA = 'oauth-2025-04-20'
const FETCH_TIMEOUT_MS = 8000
const POLL_MS = 15 * 60 * 1000
const FOCUS_DEBOUNCE_MS = 5 * 60 * 1000

interface OAuthCreds {
  accessToken: string | null
  email: string | null
}

/** Parse a credentials JSON blob; tokens may sit at top level or under `claudeAiOauth`. */
function parseCreds(raw: string): OAuthCreds {
  try {
    const j = JSON.parse(raw) as Record<string, any>
    const o = (j.claudeAiOauth ?? j) as Record<string, any>
    const accessToken = typeof o.accessToken === 'string' ? o.accessToken : null
    const email =
      (typeof o.email === 'string' && o.email) ||
      (typeof o.emailAddress === 'string' && o.emailAddress) ||
      null
    return { accessToken, email }
  } catch {
    return { accessToken: null, email: null }
  }
}

/** The OAuth access token alone (keychain → ~/.claude/.credentials.json), or null. */
export async function resolveClaudeAccessToken(): Promise<string | null> {
  return (await resolveCreds()).accessToken
}

/** macOS Keychain → ~/.claude/.credentials.json → email backfill from ~/.claude.json. */
async function resolveCreds(): Promise<OAuthCreds> {
  let creds: OAuthCreds = { accessToken: null, email: null }

  if (process.platform === 'darwin') {
    for (const service of ['Claude Code-credentials', 'claudeAiOauth']) {
      try {
        const { stdout } = await execFileP('security', [
          'find-generic-password',
          '-s',
          service,
          '-w'
        ])
        const parsed = parseCreds(stdout.trim())
        if (parsed.accessToken) {
          creds = parsed
          break
        }
      } catch {
        // not in keychain under this service — try the next / the file
      }
    }
  }

  if (!creds.accessToken) {
    try {
      const raw = await fs.readFile(path.join(os.homedir(), '.claude', '.credentials.json'), 'utf-8')
      creds = parseCreds(raw)
    } catch {
      // no file — leave creds empty
    }
  }

  if (creds.accessToken && !creds.email) {
    try {
      const raw = await fs.readFile(path.join(os.homedir(), '.claude.json'), 'utf-8')
      const j = JSON.parse(raw) as Record<string, any>
      const acct = j.oauthAccount as Record<string, any> | undefined
      const email =
        (acct && typeof acct.emailAddress === 'string' && acct.emailAddress) ||
        (acct && typeof acct.email === 'string' && acct.email) ||
        null
      if (email) creds = { ...creds, email }
    } catch {
      // best-effort only
    }
  }

  return creds
}

function mapWindow(raw: any): ClaudeUsageWindow | null {
  if (!raw || typeof raw.utilization !== 'number') return null
  const leftPercent = Math.min(100, Math.max(0, 100 - raw.utilization))
  const resetsAt = typeof raw.resets_at === 'string' ? Date.parse(raw.resets_at) || null : null
  return { leftPercent, resetsAt }
}

async function fetchUsage(): Promise<ClaudeUsage> {
  const now = Date.now()
  const { accessToken, email } = await resolveCreds()
  if (!accessToken) {
    return { session: null, weekly: null, email, updatedAt: now, status: 'unavailable' }
  }
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS)
    const res = await fetch(USAGE_URL, {
      signal: ctrl.signal,
      cache: 'no-cache',
      headers: { authorization: `Bearer ${accessToken}`, 'anthropic-beta': OAUTH_BETA }
    }).finally(() => clearTimeout(t))
    if (!res.ok) {
      // 401/403 → token is an API key or expired: no subscription windows to show.
      const status = res.status === 401 || res.status === 403 ? 'unavailable' : 'error'
      return { session: null, weekly: null, email, updatedAt: now, status }
    }
    const data = (await res.json()) as Record<string, any>
    return {
      session: mapWindow(data.five_hour),
      weekly: mapWindow(data.seven_day),
      email,
      updatedAt: now,
      status: 'ok'
    }
  } catch {
    return { session: null, weekly: null, email, updatedAt: now, status: 'error' }
  }
}

export function initClaudeUsage(win: BrowserWindow): void {
  let last: ClaudeUsage | null = null
  let lastFetchAt = 0
  let inFlight: Promise<ClaudeUsage> | null = null

  const push = (u: ClaudeUsage): void => {
    last = u
    lastFetchAt = u.updatedAt
    if (!win.isDestroyed()) win.webContents.send(IPC.usageUpdate, u)
  }

  const run = async (): Promise<ClaudeUsage> => {
    if (inFlight) return inFlight
    inFlight = fetchUsage()
    try {
      const u = await inFlight
      push(u)
      return u
    } finally {
      inFlight = null
    }
  }

  ipcMain.handle(IPC.usageFetch, async () => {
    if (last && Date.now() - lastFetchAt < FOCUS_DEBOUNCE_MS) return last
    return run()
  })
  ipcMain.handle(IPC.usageRefresh, () => run())

  void run()
  const interval = setInterval(() => {
    if (win.isFocused()) void run()
  }, POLL_MS)

  const onFocus = (): void => {
    if (Date.now() - lastFetchAt >= FOCUS_DEBOUNCE_MS) void run()
  }
  win.on('focus', onFocus)
  win.on('closed', () => clearInterval(interval))
}
