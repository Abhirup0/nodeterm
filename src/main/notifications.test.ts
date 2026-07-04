import { describe, it, expect, beforeEach } from 'vitest'
import {
  retainUntilDismissed,
  retainedNotificationCount,
  clearRetainedNotifications,
  MAX_RETAINED_NOTIFICATIONS,
  type NotificationLike
} from './notifications'

// Minimal EventEmitter-ish stand-in for Electron's Notification.
function fakeNotification(): NotificationLike & { emit(event: string): void } {
  const listeners = new Map<string, Array<() => void>>()
  return {
    on(event: string, cb: () => void) {
      const list = listeners.get(event) ?? []
      list.push(cb)
      listeners.set(event, list)
    },
    emit(event: string) {
      for (const cb of listeners.get(event) ?? []) cb()
    }
  }
}

describe('retainUntilDismissed', () => {
  beforeEach(() => clearRetainedNotifications())

  it('retains a notification so it cannot be garbage-collected', () => {
    retainUntilDismissed(fakeNotification())
    expect(retainedNotificationCount()).toBe(1)
  })

  it('releases on click', () => {
    const n = fakeNotification()
    retainUntilDismissed(n)
    n.emit('click')
    expect(retainedNotificationCount()).toBe(0)
  })

  it('releases on close', () => {
    const n = fakeNotification()
    retainUntilDismissed(n)
    n.emit('close')
    expect(retainedNotificationCount()).toBe(0)
  })

  it('releases on failed', () => {
    const n = fakeNotification()
    retainUntilDismissed(n)
    n.emit('failed')
    expect(retainedNotificationCount()).toBe(0)
  })

  it('a click on one notification does not release the others', () => {
    const a = fakeNotification()
    retainUntilDismissed(a)
    retainUntilDismissed(fakeNotification())
    a.emit('click')
    expect(retainedNotificationCount()).toBe(1)
  })

  it('caps retained notifications by dropping the oldest', () => {
    for (let i = 0; i < MAX_RETAINED_NOTIFICATIONS + 5; i++) retainUntilDismissed(fakeNotification())
    expect(retainedNotificationCount()).toBe(MAX_RETAINED_NOTIFICATIONS)
  })
})
