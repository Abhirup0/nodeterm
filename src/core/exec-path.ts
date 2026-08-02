// Executable resolution for a GUI process, without ever spawning a login shell SYNCHRONOUSLY.
//
// A GUI app launched from Finder/Dock inherits only a minimal PATH (`/usr/bin:/bin:…`) — it
// never sees Homebrew, `~/.local/bin`, nvm, etc. The historical fix was a sync
// `execFileSync($SHELL, ['-lc', 'command -v <bin>'])` per lookup, but sourcing the user's
// profile routinely takes 100-800ms (nvm/conda init) and a synchronous spawn of it sits on the
// MAIN thread — freezing every window, every PTY flush and all IPC for its duration (and the
// tmux-missing banner re-probes on a 3s poll, so it froze repeatedly).
//
// The replacement: resolve the login-shell PATH ONCE, asynchronously (`resolveShellPath`,
// prewarmed at boot), and make every lookup a subprocess-free walk of that cached PATH string
// (`findInPathString` — an accessSync per entry). Callers that run before the async probe has
// settled fall back to the inherited PATH plus their own well-known locations, and simply
// re-probe later (see each caller's memoization notes).
import fs from 'fs'
import os from 'os'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'

const runAsync = promisify(execFile)

/**
 * Resolve the user's REAL login-shell PATH once, and cache it.
 *
 * We run the user's login + interactive shell (so BOTH profile files and `.zshrc`/`.bashrc`
 * PATH additions are seen) and read back `$PATH`, printed between sentinels to survive any
 * dotfile noise. Bounded by a timeout; on any failure (hang, dotfile error, non-POSIX shell,
 * Windows) we fall back to the inherited PATH.
 */
let cachedShellPath: string | null | undefined
let shellPathPromise: Promise<string | null> | null = null
export function resolveShellPath(): Promise<string | null> {
  if (cachedShellPath !== undefined) return Promise.resolve(cachedShellPath)
  if (shellPathPromise) return shellPathPromise
  if (os.platform() === 'win32') {
    cachedShellPath = null
    return Promise.resolve(null)
  }
  const shell = process.env.SHELL || '/bin/bash'
  const START = '__NT_PATH_START__'
  const END = '__NT_PATH_END__'
  // `-ilc` = login + interactive (matches VS Code's shell-env resolution): sources the profile
  // files AND the interactive rc (`.zshrc`/`.bashrc`) where users commonly add nvm/bun/etc.
  // Dotfiles routinely take hundreds of ms (nvm/conda init) and can hang, so this MUST be
  // async — a synchronous probe here froze every window and all IPC for up to the 5s timeout.
  // stderr is captured separately by execFile, so prompt/compinit noise can't pollute stdout.
  shellPathPromise = runAsync(shell, ['-ilc', `command printf '${START}%s${END}' "$PATH"`], {
    encoding: 'utf-8',
    timeout: 5000
  })
    .then(({ stdout }) => {
      const m = stdout.match(new RegExp(`${START}([\\s\\S]*?)${END}`))
      return m?.[1]?.trim() || null
    })
    .catch(() => null) // login shell hung / errored / isn't POSIX — inherited-PATH fallback
    .then((resolved) => {
      cachedShellPath = resolved
      return resolved
    })
  return shellPathPromise
}

/** The cached login-shell PATH: a string once resolved, null if the probe failed, undefined
 *  while the async probe is still in flight (callers should then fall back + re-probe later). */
export function shellPathNow(): string | null | undefined {
  return cachedShellPath
}

/** Walk a PATH string for an executable — sync but SUBPROCESS-FREE (one accessSync per entry),
 *  so it is safe on the main thread. Returns the first accessible match, or null. */
export function findInPathString(bin: string, pathStr: string | null | undefined): string | null {
  for (const dir of (pathStr ?? '').split(path.delimiter)) {
    if (!dir) continue
    const candidate = path.join(dir, bin)
    try {
      fs.accessSync(candidate, fs.constants.X_OK)
      return candidate
    } catch {
      // not here — keep looking
    }
  }
  return null
}

/**
 * Resolve `bin` against the cached login-shell PATH (falling back to the inherited PATH while
 * the probe is in flight), then against the caller's well-known locations. Never spawns.
 */
export function findExecutableSync(bin: string, fallbacks: string[] = []): string | null {
  const hit = findInPathString(bin, cachedShellPath ?? process.env.PATH)
  if (hit) return hit
  for (const c of fallbacks) {
    try {
      fs.accessSync(c, fs.constants.X_OK)
      return c
    } catch {
      // keep trying
    }
  }
  return null
}
