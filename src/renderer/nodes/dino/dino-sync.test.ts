import { describe, it, expect } from 'vitest'
import type { DinoSnapshot } from '@shared/presence'
import { DinoSync, DINO_BROADCAST_HZ, DINO_BROADCAST_INTERVAL_MS } from './dino-sync'

function snap(over: Partial<DinoSnapshot> = {}): DinoSnapshot {
  return {
    y: -12,
    ducking: false,
    crashed: false,
    started: true,
    score: 123,
    speed: 400,
    groundScroll: 6,
    obstacles: [{ kind: 'cactus', x: 200, y: 0, sx: 228, sw: 17, sh: 35, flap: 0 }],
    ...over
  }
}

describe('DinoSync', () => {
  it('starts in local (authority) mode', () => {
    const s = new DinoSync()
    expect(s.isAuthority()).toBe(true)
    expect(s.isRemote()).toBe(false)
    expect(s.mode).toBe('local')
    expect(s.remoteSnap).toBe(null)
  })

  it('throttles broadcast to ~20 Hz (one emit per interval, first frame immediate)', () => {
    expect(DINO_BROADCAST_HZ).toBe(20)
    expect(DINO_BROADCAST_INTERVAL_MS).toBe(50)
    const s = new DinoSync()
    expect(s.tick(0, true)).toBe('snapshot') // first active frame emits immediately
    expect(s.tick(10, true)).toBe('none')
    expect(s.tick(49, true)).toBe('none')
    expect(s.tick(50, true)).toBe('snapshot') // 50 ms later → emit
    expect(s.tick(60, true)).toBe('none')
    expect(s.tick(100, true)).toBe('snapshot')
  })

  it('emits exactly one null on the transition into idle, then nothing', () => {
    const s = new DinoSync()
    s.tick(0, true) // broadcasting
    expect(s.tick(50, false)).toBe('null') // active → idle: one null
    expect(s.tick(100, false)).toBe('none') // stays idle: no spam
    expect(s.tick(150, false)).toBe('none')
  })

  it('does not emit a null at pure startup idle (no prior broadcast)', () => {
    const s = new DinoSync()
    expect(s.tick(0, false)).toBe('none')
    expect(s.tick(16, false)).toBe('none')
    expect(s.endBroadcast()).toBe('none')
  })

  it('endBroadcast (blur/stop/destroy) emits one null, then none', () => {
    const s = new DinoSync()
    s.tick(0, true) // broadcasting
    expect(s.endBroadcast()).toBe('null')
    expect(s.endBroadcast()).toBe('none')
  })

  it('re-broadcasts immediately after a stop edge when active resumes', () => {
    const s = new DinoSync()
    s.tick(0, true)
    s.endBroadcast()
    expect(s.tick(5, true)).toBe('snapshot') // resumed run emits at once, not throttled
  })

  it('setRemote(snap) enters remote mode and suspends all emits (spectator is silent)', () => {
    const s = new DinoSync()
    const view = snap()
    s.setRemote(view)
    expect(s.isRemote()).toBe(true)
    expect(s.isAuthority()).toBe(false)
    expect(s.remoteSnap).toBe(view)
    expect(s.tick(0, true)).toBe('none') // a spectator never broadcasts
    expect(s.tick(1000, true)).toBe('none')
    expect(s.endBroadcast()).toBe('none')
  })

  it('setRemote(null) returns to local authority', () => {
    const s = new DinoSync()
    s.setRemote(snap())
    s.setRemote(null)
    expect(s.isAuthority()).toBe(true)
    expect(s.remoteSnap).toBe(null)
  })

  it('takeOver() flips remote→local and returns the seed snapshot', () => {
    const s = new DinoSync()
    const view = snap({ score: 999 })
    s.setRemote(view)
    const seed = s.takeOver()
    expect(seed).toBe(view)
    expect(s.isAuthority()).toBe(true)
    expect(s.isRemote()).toBe(false)
    expect(s.remoteSnap).toBe(null)
    // take-over resumes broadcasting on the next active frame, immediately
    expect(s.tick(5000, true)).toBe('snapshot')
  })

  it('takeOver() is a no-op (null) when already local', () => {
    const s = new DinoSync()
    expect(s.takeOver()).toBe(null)
    expect(s.isAuthority()).toBe(true)
  })
})
