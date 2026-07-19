// Storage for user-pasted browser cookies, per provider.
//
// Some providers (MiniMax, opencode) publish no CLI credential on disk — their quota lives
// behind a web console session — so the only way to read it is to replay a cookie the user
// copies out of DevTools.
//
// These deliberately do NOT live in settings.json. That file is written with default
// permissions and is treated throughout the app as CONFIG — the `claudeAccounts` list sits
// there precisely because an account list is config, not a credential. A session cookie is the
// opposite: a live bearer credential for someone's account. It gets its own file at 0600 and
// never appears in a config blob that is world-readable, copied between machines, or pasted
// into a bug report.
//
// Generalized from the MiniMax-only version once opencode needed exactly the same thing; the
// file naming is unchanged (`<provider>-cookie.json`), so an already-stored MiniMax cookie is
// still found.
import { promises as fs } from 'fs'
import path from 'path'
import { platform } from '../platform'

/** Owner read/write only. The whole reason these are separate files. */
const MODE = 0o600

/** Providers whose usage is read with a pasted browser cookie. */
export const COOKIE_PROVIDERS = ['minimax', 'opencode'] as const
export type CookieProvider = (typeof COOKIE_PROVIDERS)[number]

export function isCookieProvider(v: unknown): v is CookieProvider {
  return typeof v === 'string' && (COOKIE_PROVIDERS as readonly string[]).includes(v)
}

function file(provider: CookieProvider): string {
  return path.join(platform().userDataDir, `${provider}-cookie.json`)
}

/** The stored cookie header, or null when this provider has not been configured. */
export async function readProviderCookie(provider: CookieProvider): Promise<string | null> {
  try {
    const raw = await fs.readFile(file(provider), 'utf-8')
    const j = JSON.parse(raw) as Record<string, unknown>
    return typeof j.cookie === 'string' && j.cookie.trim() ? j.cookie : null
  } catch {
    return null
  }
}

/**
 * Store (or, with an empty value, clear) a provider's cookie. Written to a temp file first and
 * renamed, so a crash mid-write cannot leave a half-written credential behind — and the temp
 * file is created with the restricted mode too, since a rename preserves the source's mode.
 */
export async function writeProviderCookie(provider: CookieProvider, cookie: string): Promise<void> {
  const target = file(provider)
  if (!cookie.trim()) {
    await fs.rm(target, { force: true })
    return
  }
  const tmp = `${target}.tmp`
  await fs.writeFile(tmp, JSON.stringify({ cookie }), { encoding: 'utf-8', mode: MODE })
  await fs.rename(tmp, target)
  // Belt and braces: a temp file left by an earlier run would keep its own mode.
  await fs.chmod(target, MODE).catch(() => undefined)
}

/** Whether a cookie is stored — for the settings UI, which must never read the value back. */
export async function hasProviderCookie(provider: CookieProvider): Promise<boolean> {
  return (await readProviderCookie(provider)) !== null
}
