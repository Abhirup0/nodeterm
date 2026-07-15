import { beforeEach, describe, expect, it } from 'vitest'
import {
  addPending,
  clearSeats,
  connectedCount,
  listSeats,
  markConnected,
  markPending,
  pendingCount,
  removeSeat,
  usedCount,
  type SeatsState
} from './teamAccessCore'
import { useTeamAccess } from './teamAccess'

describe('teamAccessCore (pure reducer)', () => {
  const empty: SeatsState = {}

  it('addPending adds a pending seat with its email', () => {
    const s = addPending(empty, 'a', 'ayse@x.com')
    expect(s.a).toEqual({ id: 'a', email: 'ayse@x.com', status: 'pending' })
    expect(pendingCount(s)).toBe(1)
    expect(connectedCount(s)).toBe(0)
  })

  it('markConnected transitions a known pending seat to connected', () => {
    let s = addPending(empty, 'a', 'ayse@x.com')
    s = markConnected(s, 'a')
    expect(s.a.status).toBe('connected')
    expect(s.a.email).toBe('ayse@x.com')
    expect(connectedCount(s)).toBe(1)
  })

  it('usedCount counts pending AND connected (matches the Task-2 seat cap = byId.size)', () => {
    let s = addPending(empty, 'a', 'ayse@x.com')
    s = addPending(s, 'b')
    // both pending → both consume a seat
    expect(usedCount(s)).toBe(2)
    s = markConnected(s, 'a')
    expect(usedCount(s)).toBe(2)
    expect(connectedCount(s)).toBe(1)
    expect(pendingCount(s)).toBe(1)
  })

  it('remove drops the seat', () => {
    let s = addPending(empty, 'a', 'ayse@x.com')
    s = removeSeat(s, 'a')
    expect(s.a).toBeUndefined()
    expect(usedCount(s)).toBe(0)
  })

  it('markPending on an already-added id enriches email without duplicating or losing status', () => {
    let s = addPending(empty, 'a') // minted without an email
    s = markPending(s, 'a', 'ayse@x.com') // the peer-pending event carries it
    expect(Object.keys(s)).toHaveLength(1)
    expect(s.a.email).toBe('ayse@x.com')
    expect(s.a.status).toBe('pending')
  })

  it('markPending adds the seat when the event beats the invite-return add', () => {
    const s = markPending(empty, 'a', 'ayse@x.com')
    expect(s.a).toEqual({ id: 'a', email: 'ayse@x.com', status: 'pending' })
  })

  it('markPending never downgrades an already-connected seat', () => {
    let s = addPending(empty, 'a', 'ayse@x.com')
    s = markConnected(s, 'a')
    s = markPending(s, 'a')
    expect(s.a.status).toBe('connected')
  })

  it('markConnected on an unknown id is a no-op (a seat always exists from mint)', () => {
    const s = markConnected(empty, 'ghost')
    expect(s).toEqual({})
  })

  it('clearSeats empties the record', () => {
    let s = addPending(empty, 'a', 'ayse@x.com')
    s = addPending(s, 'b')
    expect(clearSeats()).toEqual({})
  })

  it('listSeats returns seats in insertion order', () => {
    let s = addPending(empty, 'a')
    s = addPending(s, 'b')
    s = addPending(s, 'c')
    expect(listSeats(s).map((e) => e.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('useTeamAccess store', () => {
  beforeEach(() => useTeamAccess.getState().clear())

  it('addPending → markConnected → remove flows through the store', () => {
    const { addPending: add, markConnected: connect, remove } = useTeamAccess.getState()
    add('a', 'ayse@x.com')
    expect(useTeamAccess.getState().seats.a.status).toBe('pending')
    connect('a')
    expect(useTeamAccess.getState().seats.a.status).toBe('connected')
    expect(usedCount(useTeamAccess.getState().seats)).toBe(1)
    remove('a')
    expect(useTeamAccess.getState().seats.a).toBeUndefined()
  })

  it('markPending enriches without duplicating', () => {
    const st = useTeamAccess.getState()
    st.addPending('a')
    st.markPending('a', 'ayse@x.com')
    expect(Object.keys(useTeamAccess.getState().seats)).toHaveLength(1)
    expect(useTeamAccess.getState().seats.a.email).toBe('ayse@x.com')
  })

  it('clear empties the store', () => {
    useTeamAccess.getState().addPending('a')
    useTeamAccess.getState().clear()
    expect(useTeamAccess.getState().seats).toEqual({})
  })
})
