import { describe, expect, it } from 'vitest'
import { MacWheelGestureRouter } from './wheel-gesture'

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

  it('keeps pinch, Cmd-wheel, line-mode wheel and other platforms off the override', () => {
    const router = new MacWheelGestureRouter()
    expect(router.shouldPan(gesture(5, { ctrlKey: true }), true, 1000)).toBe(false)
    expect(router.shouldPan(gesture(5, { metaKey: true }), true, 1000)).toBe(false)
    expect(router.shouldPan(gesture(3, { deltaMode: 1 }), true, 1000)).toBe(false)
    expect(router.shouldPan(gesture(5), false, 1000)).toBe(false)
  })
})
