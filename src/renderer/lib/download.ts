// Which download route (if any) the Explorer offers for the tree it is currently showing.
//
// "Download" only means something when the file is NOT already on the user's machine, and the two
// cases where it isn't are reached by completely different transports:
//
//  - **Desktop + SSH project** — the tree is another host's filesystem, so the file comes down over
//    the project's ControlMaster with `scp` and lands in the OS Downloads folder. This is the only
//    route that streams straight to disk, which is why big files must take it.
//  - **Browser (Server Edition)** — every file in the tree is on the server, including a "local"
//    project's. The transfer is a plain HTTP GET against a one-shot ticket, and the browser saves
//    it. NOT `fs.readBinary`: that base64s the whole file into one RPC message and is capped.
//
// Everything else answers `none`, and the affordance is hidden rather than shown-and-broken:
//  - **Desktop + local project** — the file is already on this machine; Reveal in Finder is the
//    honest action, and it is right there in the same menu.
//  - **Relay tab** — the files are on the peer's machine and the only path to them is the bridged
//    `fs.readBinary`, i.e. the capped base64 one. Offering a Download that silently truncates a
//    25 MB file would be worse than not offering it; a real relay transport is follow-up work.
import type { SessionSource } from '../session/session'

export type DownloadRoute = 'scp' | 'http' | 'none'

export interface DownloadContext {
  /** Renderer shell: a browser tab (Server Edition) vs Electron. */
  browser: boolean
  /** The Explorer's project is an SSH project (its tree is the remote host's fs). */
  ssh: boolean
  /** Which session the active project's tab belongs to. */
  source: SessionSource
}

export function downloadRoute({ browser, ssh, source }: DownloadContext): DownloadRoute {
  if (source === 'relay') return 'none'
  if (ssh) {
    // An SSH project's tree is served by the desktop's ControlMaster; the Server Edition has no
    // SSH projects at all (its sshFs members are unsupported stubs), so a browser + ssh pairing
    // is not a thing we can serve — say so rather than minting a ticket for a path that is not on
    // the server's own disk.
    return browser ? 'none' : 'scp'
  }
  return browser ? 'http' : 'none'
}

/**
 * True when "Reveal in Finder" can actually do something: an Electron shell, showing paths that
 * are on THIS machine. It was previously offered unconditionally — on an SSH project it handed a
 * remote path to the local file manager, and in a browser tab it is an inert stub. Both were
 * silent no-ops, which reads as a broken app rather than as an unavailable feature.
 */
export function canRevealLocally({ browser, ssh, source }: DownloadContext): boolean {
  return !browser && !ssh && source !== 'relay'
}

/**
 * Start a browser download for `url` without navigating the page. An anchor with `download` is
 * used rather than `location.assign` so a response that (for any reason) lacks
 * `Content-Disposition` still saves instead of replacing the app. The `name` is a hint only — the
 * server's header wins, and must, because it knows a folder became `<name>.tar.gz`.
 */
export function triggerBrowserDownload(url: string, name: string): void {
  const a = document.createElement('a')
  a.href = url
  a.download = name
  a.rel = 'noopener'
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  a.remove()
}
