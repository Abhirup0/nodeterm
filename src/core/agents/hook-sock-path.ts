import { createHash } from 'crypto'
import os from 'os'
import path from 'path'

/**
 * Where the hook server's unix-domain listener binds (issue #367).
 *
 * The SUN_LEN limit is REAL and this repo has hit it twice: `sun_path` is 104 bytes on macOS
 * (108 on Linux) INCLUDING the trailing NUL, and both the SSH ControlMaster
 * (`core/remote-ssh/control-master.ts`) and the codex relay daemon learned that a socket under a
 * long data dir simply fails to bind/connect. So the same discipline applies here:
 *
 *  - primary: `<userDataDir>/sock/hook.sock` — a deliberately SHORT filename inside a private
 *    0700 subdirectory (the directory's mode is what actually protects the socket from other
 *    local users; the 0600 chmod on the socket file itself is belt and braces);
 *  - fallback, when the primary would not fit sun_path (a deep macOS "Application Support" path,
 *    a long username): `~/.nodeterm/sock/hook-<sha256(userDataDir)[:16]>.sock` — the exact shape
 *    `controlSocketPath` uses for the SSH masters. Home, NOT os.tmpdir(): a world-writable /tmp
 *    lets any local user pre-create ("squat") the predictable name, and the sticky bit then stops
 *    us from unlinking it — the homedir path has neither problem. The digest keys the file to the
 *    data dir so two instances (two data dirs) never fight over one socket.
 */
export const SUN_PATH_BUDGET = 103

export function hookSockPath(userDataDir: string, home: string = os.homedir()): string {
  const primary = path.join(userDataDir, 'sock', 'hook.sock')
  if (Buffer.byteLength(primary, 'utf8') <= SUN_PATH_BUDGET) return primary
  const id = createHash('sha256').update(userDataDir).digest('hex').slice(0, 16)
  return path.join(home, '.nodeterm', 'sock', `hook-${id}.sock`)
}
