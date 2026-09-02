/**
 * What THIS machine calls its SSH server, and how the user turns it on.
 *
 * Phone pairing installs the phone's key into `~/.ssh/authorized_keys` and the phone then connects
 * over SSH, so the QR is withheld until something answers on `127.0.0.1:22` — a pairing completed
 * against a dead sshd installs a key that can never be used. That gate is fine; the WORDS around
 * it were macOS-only ("Remote Login", a `x-apple.systempreferences:` deep link), which on Windows
 * named a setting the OS does not have and a button that opened nothing (issue #572).
 *
 * One definition, two consumers: the renderer prints the copy (deriving the OS from its own UA —
 * the pairing host is this machine) and the main process opens `settingsUrl`. Keeping the URL here
 * rather than beside the handler is what stops the button from appearing on a platform main cannot
 * open anything for.
 */

export type HostOs = 'mac' | 'windows' | 'other'

export interface SshServerCopy {
  /** The service's name on this OS, used as the SUBJECT of a sentence ("<name> is off, so …"). */
  name: string
  /** Where to turn it on, in that OS's own words. */
  how: string
  /** Label for the deep-link button — present only when `settingsUrl` is. */
  settingsLabel?: string
  /** A settings deep link the MAIN process may open. Absent = no button. */
  settingsUrl?: string
}

/** `process.platform` (or any platform string) → the three cases the copy distinguishes. */
export function hostOsFromPlatform(platform: string): HostOs {
  if (platform === 'darwin') return 'mac'
  if (platform === 'win32') return 'windows'
  return 'other'
}

/**
 * The renderer's own OS, from the same `navigator` sniff the shortcut labels use.
 *
 * Correct for pairing because the pairing host IS this machine — the service is desktop-only
 * (`ipcMain.handle`, an `E_UNSUPPORTED` stub in the browser bridge), so there is no case where
 * this renderer prints the copy for a machine other than the one running sshd.
 */
export function hostOsFromNavigator(): HostOs {
  if (typeof navigator === 'undefined') return 'other'
  const ua = navigator.platform || navigator.userAgent
  if (/Mac/i.test(ua)) return 'mac'
  if (/Win/i.test(ua)) return 'windows'
  return 'other'
}

export function sshServerCopy(os: HostOs): SshServerCopy {
  if (os === 'mac')
    return {
      name: 'Remote Login',
      how: 'System Settings → General → Sharing → Remote Login.',
      settingsLabel: 'Open System Settings',
      // The `Services_RemoteLogin` query selected the service in the pre-Ventura prefpane and is
      // harmless on newer macOS, which opens the Sharing pane either way.
      settingsUrl: 'x-apple.systempreferences:com.apple.preferences.sharing?Services_RemoteLogin'
    }
  if (os === 'windows')
    return {
      // OpenSSH Server is an OPTIONAL FEATURE on Windows and is off on a stock machine — so this
      // is usually "install it", not "flip a switch", and the copy has to say both steps.
      name: 'OpenSSH Server',
      how: 'Settings → System → Optional features → Add an optional feature → OpenSSH Server, then start the “OpenSSH SSH Server” service (Services, or `Start-Service sshd`).',
      settingsLabel: 'Open Optional features',
      settingsUrl: 'ms-settings:optionalfeatures'
    }
  return {
    name: 'The SSH server',
    how: 'Install and start an SSH server (e.g. `sudo apt install openssh-server && sudo systemctl enable --now ssh`).'
  }
}
