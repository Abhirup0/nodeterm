type WheelGesture = Pick<WheelEvent, 'ctrlKey' | 'metaKey' | 'deltaMode' | 'deltaX' | 'deltaY'> & {
  wheelDeltaY?: number
}

export type MacWheelDestination = 'flow-pan' | 'native'

const TRACKPAD_SEQUENCE_MS = 500
const MOUSE_WHEEL_NOTCH = 120
const LARGE_PIXEL_DELTA = 40

/** Pixel mode alone is not a device identity: Chromium uses it for trackpads and many mice. */
export class MacWheelGestureRouter {
  private trackpadUntil = 0

  shouldPan(event: WheelGesture, mac: boolean, now = performance.now()): boolean {
    if (!mac || event.ctrlKey || event.metaKey || event.deltaMode !== 0) return false
    // Device identity is sticky for one physical gesture. Chromium can quantize a later
    // trackpad/momentum event to wheelDeltaY=120; treating that single packet as a mouse notch
    // hands it to wheelZoom and creates the observed one-frame zoom inside an otherwise pure pan.
    if (now <= this.trackpadUntil) {
      this.trackpadUntil = now + TRACKPAD_SEQUENCE_MS
      return true
    }
    const legacyDelta = Math.abs(event.wheelDeltaY ?? 0)
    const mouseNotch = legacyDelta >= MOUSE_WHEEL_NOTCH && legacyDelta % MOUSE_WHEEL_NOTCH === 0
    if (mouseNotch) {
      this.trackpadUntil = 0
      return false
    }
    const smooth =
      event.deltaX !== 0 ||
      !Number.isInteger(event.deltaX) ||
      !Number.isInteger(event.deltaY) ||
      Math.abs(event.deltaY) < LARGE_PIXEL_DELTA
    if (smooth) {
      this.trackpadUntil = now + TRACKPAD_SEQUENCE_MS
      return true
    }
    return false
  }

  destination(
    event: WheelGesture,
    mac: boolean,
    overNativeScrollable: boolean,
    now = performance.now()
  ): MacWheelDestination {
    if (!this.shouldPan(event, mac, now)) return 'native'
    return overNativeScrollable ? 'native' : 'flow-pan'
  }
}
