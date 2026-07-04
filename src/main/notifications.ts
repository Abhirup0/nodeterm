// Electron garbage-collects Notification objects nothing references (electron/electron#16922):
// the notification still shows, but once the wrapper is collected its 'click' handler is gone —
// clicking then only activates the app (macOS default) instead of running our focus logic.
// Retain every shown notification here until the OS reports it dismissed.

// Structural view of Electron's Notification (keeps this module electron-free and unit-testable).
export interface NotificationLike {
  on(event: 'click' | 'close' | 'failed', cb: () => void): void
}

// Backstop for notifications macOS parks in Notification Center without ever emitting
// 'close' — beyond this, the oldest retained one is dropped (its click stops working,
// which is the pre-fix behavior; anything recent keeps its handler alive).
export const MAX_RETAINED_NOTIFICATIONS = 50

const live = new Set<NotificationLike>()

export function retainUntilDismissed(n: NotificationLike): void {
  live.add(n)
  const release = () => live.delete(n)
  n.on('click', release)
  n.on('close', release)
  n.on('failed', release)
  while (live.size > MAX_RETAINED_NOTIFICATIONS) {
    const oldest = live.values().next().value
    if (!oldest) break
    live.delete(oldest)
  }
}

export function retainedNotificationCount(): number {
  return live.size
}

export function clearRetainedNotifications(): void {
  live.clear()
}
