import { describe, it, expect, vi } from 'vitest'
import { createMemoryPressureMonitor } from './memory-pressure'

const mem = (availableMb: number, totalMb = 16000) => () => ({ availableMb, totalMb })

describe('memory pressure monitor', () => {
  it('classifies warning below 10% available and critical below 5%', () => {
    const on = vi.fn()
    const m = createMemoryPressureMonitor({ readMem: mem(1500), selfRssMb: () => 500, onPressure: on })
    expect(m.check()).toBe('warning')
    const c = createMemoryPressureMonitor({ readMem: mem(700), selfRssMb: () => 500, onPressure: on })
    expect(c.check()).toBe('critical')
  })
  it('a failed mem read is never pressure', () => {
    const m = createMemoryPressureMonitor({ readMem: () => null, selfRssMb: () => 500, onPressure: vi.fn() })
    expect(m.check()).toBeNull()
  })
  it('self-RSS thresholds fire independently of host memory', () => {
    const m = createMemoryPressureMonitor({ readMem: mem(8000), selfRssMb: () => 5000, onPressure: vi.fn() })
    expect(m.check()).toBe('warning')
    const c = createMemoryPressureMonitor({ readMem: mem(8000), selfRssMb: () => 9000, onPressure: vi.fn() })
    expect(c.check()).toBe('critical')
  })
  it('re-fires a severity at most once per 60s (edge-trigger + floor)', () => {
    vi.useFakeTimers()
    const on = vi.fn()
    const m = createMemoryPressureMonitor({ readMem: mem(1500), selfRssMb: () => 0, intervalMs: 1000, onPressure: on })
    m.start()
    vi.advanceTimersByTime(3500)
    expect(on).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(60_000)
    expect(on).toHaveBeenCalledTimes(2)
    m.stop()
    vi.useRealTimers()
  })
})
