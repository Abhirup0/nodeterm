import { describe, expect, it } from 'vitest'
import { MacWheelGestureRouter, trackpadRoutingEnabled } from './wheel-gesture'

const gesture = (
  deltaY: number,
  o: Partial<{
    deltaX: number
    deltaMode: number
    ctrlKey: boolean
    metaKey: boolean
    wheelDeltaY: number
  }> = {}
) => ({
  deltaY,
  deltaX: o.deltaX ?? 0,
  deltaMode: o.deltaMode ?? 0,
  ctrlKey: o.ctrlKey ?? false,
  metaKey: o.metaKey ?? false,
  wheelDeltaY: o.wheelDeltaY
})

const yes = () => true
const no = () => false

describe('MacWheelGestureRouter', () => {
  it('keeps a notched macOS mouse wheel on the user-configured zoom path', () => {
    const router = new MacWheelGestureRouter()
    expect(router.shouldPan(gesture(100, { wheelDeltaY: -120 }), true, 1000)).toBe(false)
    expect(router.shouldPan(gesture(-100, { wheelDeltaY: 120 }), true, 1100)).toBe(false)
  })

  it('routes smooth two-finger trackpad scroll and its momentum to panning', () => {
    const router = new MacWheelGestureRouter()
    expect(router.shouldPan(gesture(6.25), true, 1000)).toBe(true)
    expect(router.shouldPan(gesture(75), true, 1080)).toBe(true)
    expect(router.shouldPan(gesture(75), true, 1700)).toBe(false)
  })

  it('does not reclassify a quantized packet in an active trackpad gesture as mouse zoom', () => {
    const router = new MacWheelGestureRouter()
    expect(router.shouldPan(gesture(4.5), true, 1000)).toBe(true)
    expect(router.shouldPan(gesture(100, { wheelDeltaY: -120 }), true, 1150)).toBe(true)
    expect(router.shouldPan(gesture(70), true, 1500)).toBe(true)
  })

  it('keeps trackpad scrolling native over terminal and other native scroll surfaces', () => {
    const router = new MacWheelGestureRouter()
    expect(router.destination(gesture(6.25), true, yes, 1000)).toBe('native')
    expect(router.destination(gesture(6.25), true, no, 1400)).toBe('flow-pan')
    expect(router.destination(gesture(100, { wheelDeltaY: -120 }), true, yes, 1800)).toBe('native')
  })

  it('does not pan over a non-terminal native scroller, and still knows the gesture is a trackpad', () => {
    const router = new MacWheelGestureRouter()
    // A trackpad gesture that begins over Monaco / a markdown pane scrolls THAT surface...
    expect(router.destination(gesture(6.25), true, yes, 1000)).toBe('native')
    // ...but the packet still classified the device, so continuing the same gesture off the
    // scroller pans the canvas instead of falling back to the mouse-notch (zoom) path.
    expect(router.destination(gesture(75), true, no, 1100)).toBe('flow-pan')
  })

  it('hands every gesture back to the zoom path once the escape hatch is engaged', () => {
    // trackpadPan off: `mac` is false for the router whatever machine this is, so nothing is
    // ever routed to flow-pan and settings.wheelZoom alone decides — the pre-router behavior.
    expect(trackpadRoutingEnabled(true, true)).toBe(true)
    expect(trackpadRoutingEnabled(true, false)).toBe(false)
    expect(trackpadRoutingEnabled(false, true)).toBe(false)

    const hatch = trackpadRoutingEnabled(true, false)
    const router = new MacWheelGestureRouter()
    // A precise-pixel MOUSE (Magic Mouse, MX Master) emits exactly what a trackpad emits, so it
    // classifies as one — this is the user's only way back to wheel zoom, and it must hold for a
    // whole gesture, not just its first packet.
    expect(router.destination(gesture(6.25), hatch, no, 1000)).toBe('native')
    expect(router.destination(gesture(4.5), hatch, no, 1050)).toBe('native')
    expect(router.destination(gesture(75), hatch, yes, 1100)).toBe('native')
    expect(router.shouldPan(gesture(6.25), hatch, 1150)).toBe(false)
  })

  it('keeps pinch, Cmd-wheel, line-mode wheel and other platforms off the override', () => {
    const router = new MacWheelGestureRouter()
    expect(router.shouldPan(gesture(5, { ctrlKey: true }), true, 1000)).toBe(false)
    expect(router.shouldPan(gesture(5, { metaKey: true }), true, 1000)).toBe(false)
    expect(router.shouldPan(gesture(3, { deltaMode: 1 }), true, 1000)).toBe(false)
    expect(router.shouldPan(gesture(5), false, 1000)).toBe(false)
  })
})

describe('MacWheelGestureRouter with main-process gesture reporting', () => {
  const reporting = () => new MacWheelGestureRouter(true)

  it('zooms a smooth-looking packet when no trackpad gesture is in flight (the MX Master fix)', () => {
    // A precise-pixel mouse emits exactly what a trackpad emits at the DOM level. With the
    // main-process ledger reporting, silence is a POSITIVE fact — no gesture is open, so this
    // is a wheel mouse and it must reach the zoom path even though the heuristic reads it as
    // a trackpad.
    const router = reporting()
    expect(router.shouldPan(gesture(6.25), true, 1000)).toBe(false)
    expect(router.shouldPan(gesture(30), true, 1010)).toBe(false)
  })

  it('pans while a reported gesture is active, even for a notch-quantized packet', () => {
    const router = reporting()
    router.noteGesture(true, 995)
    expect(router.shouldPan(gesture(100, { wheelDeltaY: -120 }), true, 1000)).toBe(true)
  })

  it('keeps panning through the touch→momentum gap after the gesture ends', () => {
    // Measured: a few mouseWheel packets arrive between the touch phase's End and the momentum
    // phase's Begin. They belong to the same physical gesture and must not blip into zoom.
    const router = reporting()
    router.noteGesture(true, 1000)
    router.noteGesture(false, 1200)
    expect(router.shouldPan(gesture(40), true, 1230)).toBe(true)
    // Long after the gesture (and its linger) the mouse owns the wheel again.
    expect(router.shouldPan(gesture(40), true, 1900)).toBe(false)
  })

  it('still refuses non-mac, modified, and line-mode packets in reporting mode', () => {
    const router = reporting()
    router.noteGesture(true, 995)
    expect(router.shouldPan(gesture(10), false, 1000)).toBe(false)
    expect(router.shouldPan(gesture(10, { ctrlKey: true }), true, 1000)).toBe(false)
    expect(router.shouldPan(gesture(10, { metaKey: true }), true, 1000)).toBe(false)
    expect(router.shouldPan(gesture(10, { deltaMode: 1 }), true, 1000)).toBe(false)
  })

  it('without reporting (default constructor) the legacy heuristics are unchanged', () => {
    const router = new MacWheelGestureRouter()
    expect(router.shouldPan(gesture(6.25), true, 1000)).toBe(true)
    expect(router.shouldPan(gesture(100, { wheelDeltaY: -120 }), true, 2000)).toBe(false)
  })

  it('noteGesture on a non-reporting router does not flip it into reporting mode', () => {
    // The stub bridge never calls this, but a defensive caller might: reporting mode is decided
    // by the shell (constructor), never inferred from traffic.
    const router = new MacWheelGestureRouter()
    router.noteGesture(true, 995)
    router.noteGesture(false, 996)
    expect(router.shouldPan(gesture(6.25), true, 1000)).toBe(true)
  })
})
