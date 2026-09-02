import { describe, expect, it } from 'vitest'
import { macTitleBarOptions } from './window-chrome'

describe('macTitleBarOptions', () => {
  it('hides the title bar and insets the traffic lights on macOS', () => {
    expect(macTitleBarOptions('darwin')).toEqual({
      titleBarStyle: 'hiddenInset',
      trafficLightPosition: { x: 16, y: 15 }
    })
  })

  // Issue #564: both options are macOS-only. Claiming them elsewhere is what made the renderer's
  // 86px traffic-light reservation look justified on a window that has a native frame.
  it('claims neither on Windows or Linux', () => {
    expect(macTitleBarOptions('win32')).toEqual({})
    expect(macTitleBarOptions('linux')).toEqual({})
  })
})
