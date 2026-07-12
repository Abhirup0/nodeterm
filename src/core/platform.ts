/**
 * The platform seam of the Server Edition split: everything in src/core talks
 * to its shell (Electron main today, the Linux server later) only through this
 * interface. src/core must never import 'electron' (see no-electron.test.ts).
 */
export interface CorePlatform {
  /** Root for all persistent state (Electron: app.getPath('userData')). */
  readonly userDataDir: string
  readonly appVersion: string
  readonly isPackaged: boolean
  /** Register a request/response RPC handler (Electron: ipcMain.handle, event stripped). */
  handle(channel: string, fn: (...args: any[]) => unknown): void
  /** Register a fire-and-forget handler (Electron: ipcMain.on, event stripped). */
  on(channel: string, fn: (...args: any[]) => void): void
  /** Like handle, but fn receives the calling UI's numeric id first (Electron: event.sender.id). */
  handleWithSender(channel: string, fn: (senderId: number, ...args: any[]) => unknown): void
  /** Like on, but fn receives the calling UI's numeric id first (Electron: event.sender.id).
   *  The seam presence (and, later, typing attribution) needs: a cast must say WHO sent it. */
  onWithSender(channel: string, fn: (senderId: number, ...args: any[]) => void): void
  /** Send to one attached UI by id (Electron: webContents.fromId). Silently drops if gone. */
  sendTo(uiId: number, channel: string, ...args: any[]): void
  /** Send to every attached UI (Electron: the main window). */
  broadcast(channel: string, ...args: any[]): void
  /** Open a URL in the user's default browser. */
  openExternal(url: string): Promise<void>
}

let current: CorePlatform | null = null

export function initPlatform(p: CorePlatform): void {
  current = p
}

export function platform(): CorePlatform {
  if (!current) throw new Error('core platform not initialized — call initPlatform() at boot')
  return current
}

export function resetPlatformForTests(): void {
  current = null
}
