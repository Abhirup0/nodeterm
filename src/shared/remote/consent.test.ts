import { describe, it, expect } from 'vitest'
import { SHELL_ACCESS_CONSENT, describeGrant } from './consent'

describe('consent copy', () => {
  it('states shell access = SSH-equivalent, in plain words', () => {
    // The user must understand the grant BEFORE accepting — this is the whole point of the copy.
    expect(SHELL_ACCESS_CONSENT).toContain('run commands on this Mac')
    expect(SHELL_ACCESS_CONSENT).toContain('the same as giving them SSH access')
  })

  it('names the peer', () => {
    expect(describeGrant('Ayşe')).toBe(
      'Ayşe will be able to run commands on this Mac — the same as giving them SSH access.'
    )
  })

  it('falls back to a generic subject when the label is empty/blank', () => {
    expect(describeGrant('')).toBe(SHELL_ACCESS_CONSENT)
    expect(describeGrant('   ')).toBe(SHELL_ACCESS_CONSENT)
    expect(describeGrant('  Bora ')).toBe(
      'Bora will be able to run commands on this Mac — the same as giving them SSH access.'
    )
  })
})
