import { describe, expect, it } from 'vitest'
import { inviteShare, seatFullMessage, teamAccessView } from './teamAccessView'

describe('teamAccessView', () => {
  it('gates a non-premium host and forbids inviting', () => {
    const v = teamAccessView({ premium: false, seats: 0, used: 0 })
    expect(v.gated).toBe(true)
    expect(v.canInvite).toBe(false)
  })

  it('allows inviting a premium host with a free seat', () => {
    const v = teamAccessView({ premium: true, seats: 5, used: 2 })
    expect(v.gated).toBe(false)
    expect(v.canInvite).toBe(true)
    expect(v.counterText).toBe('Used 2 / 5')
  })

  it('forbids inviting at cap', () => {
    const v = teamAccessView({ premium: true, seats: 3, used: 3 })
    expect(v.canInvite).toBe(false)
    expect(v.counterText).toBe('Used 3 / 3')
  })
})

describe('inviteShare', () => {
  it('builds a mailto with the encoded code, the invitee, and a body', () => {
    const { copyText, mailtoUrl } = inviteShare({ offer: 'ABC-123-xyz', email: 'ayse@x.com' })
    expect(copyText).toContain('ABC-123-xyz')
    expect(mailtoUrl.startsWith('mailto:ayse@x.com?')).toBe(true)
    expect(mailtoUrl).toContain(encodeURIComponent('ABC-123-xyz'))
    expect(mailtoUrl).toContain('body=')
    expect(mailtoUrl).toContain('subject=')
  })

  it('produces a recipientless mailto for a blank email', () => {
    const { mailtoUrl } = inviteShare({ offer: 'CODE9', email: '' })
    expect(mailtoUrl.startsWith('mailto:?')).toBe(true)
    expect(mailtoUrl).toContain(encodeURIComponent('CODE9'))
  })
})

describe('seatFullMessage', () => {
  it('recognizes the E_SEATS_FULL coded error', () => {
    expect(seatFullMessage(new Error('E_SEATS_FULL: no seats left'))).toBe(true)
  })

  it('is false for an unrelated error', () => {
    expect(seatFullMessage(new Error('network down'))).toBe(false)
    expect(seatFullMessage('some string')).toBe(false)
  })
})
