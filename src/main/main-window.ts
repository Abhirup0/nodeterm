// Live main-window tracking. Everything in the main process that pushes IPC to the
// renderer must resolve the window AT SEND TIME via getMainWindow()/sendToMain() —
// never capture a BrowserWindow in a closure at init. On macOS the window can be
// closed (app stays alive) and recreated from the dock; a captured reference then
// points at a destroyed window and every send is silently dropped (that bug shipped:
// agent status badges died after a close→reopen cycle).

// Structural view of BrowserWindow (keeps this module electron-free and unit-testable).
export interface MainWindowLike {
  isDestroyed(): boolean
  isFocused(): boolean
  isMinimized(): boolean
  restore(): void
  show(): void
  focus(): void
  on(event: 'closed', cb: () => void): void
  webContents: { send(channel: string, ...args: unknown[]): void }
}

let current: MainWindowLike | null = null

export function setMainWindow(win: MainWindowLike): void {
  current = win
  win.on('closed', () => {
    // Guard: a late 'closed' from a replaced window must not clear its successor.
    if (current === win) current = null
  })
}

export function getMainWindow(): MainWindowLike | null {
  return current && !current.isDestroyed() ? current : null
}

export function sendToMain(channel: string, ...args: unknown[]): void {
  getMainWindow()?.webContents.send(channel, ...args)
}

// macOS convention: closing the window hides it (the app — and its tmux sessions,
// hook server, updater, license watchers — keeps running); a real close only happens
// on quit. Other platforms quit on window close, so never intercept there.
export function shouldHideOnClose(platform: NodeJS.Platform | string, quitting: boolean): boolean {
  return platform === 'darwin' && !quitting
}
