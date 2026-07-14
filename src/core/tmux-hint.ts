// Pure helpers behind the "tmux not found" banner (pty:tmux-status). Without tmux the app runs in
// the silent plain-shell fallback — terminals don't survive restarts and the mobile companion
// can't attach — which users never discover on their own; the banner makes it visible and offers
// a one-click install (run in a terminal node, gh-sign-in style).

/** Suggested one-shot install command for the host, or null when no known package manager is
 *  present (the banner then shows text-only guidance). Order within linux is Debian-family first
 *  (the Server Edition's documented target), then the other majors. */
export function tmuxInstallCommand(
  platform: NodeJS.Platform | string,
  hasCommand: (cmd: string) => boolean
): string | null {
  if (platform === 'darwin') {
    return hasCommand('brew') ? 'brew install tmux' : null
  }
  if (platform === 'linux') {
    if (hasCommand('apt-get')) return 'sudo apt-get update && sudo apt-get install -y tmux'
    if (hasCommand('dnf')) return 'sudo dnf install -y tmux'
    if (hasCommand('yum')) return 'sudo yum install -y tmux'
    if (hasCommand('pacman')) return 'sudo pacman -S --needed tmux'
    if (hasCommand('zypper')) return 'sudo zypper install -y tmux'
    if (hasCommand('apk')) return 'sudo apk add tmux'
  }
  return null
}

/** Dirs GUI apps routinely miss (they don't inherit the shell PATH) — same reasoning as
 *  findTmux in pty-manager. Checked after the process PATH. */
const COMMON_BIN_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', '/opt/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']

/** Is `name` on the process PATH or in the common bin dirs? `exists` is injected (fs.existsSync
 *  in production) so the lookup stays pure and testable. */
export function findCommand(
  name: string,
  env: Record<string, string | undefined>,
  exists: (path: string) => boolean
): boolean {
  const dirs = [...(env.PATH ? env.PATH.split(':') : []), ...COMMON_BIN_DIRS]
  return dirs.some((d) => d && exists(`${d}/${name}`))
}

