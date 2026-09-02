import { describe, expect, it } from 'vitest'
import { presentAccount } from './accountPresentation'

describe('presentAccount', () => {
  it('uses a chosen name before the email and identifies a local login', () => {
    expect(presentAccount({ label: 'Work', email: 'me@example.com' })).toEqual({
      identity: 'Work',
      provenance: 'Local',
      tooltip: 'Work (me@example.com) · This computer'
    })
  })

  it('falls back to email and never exposes system or managed storage terminology', () => {
    expect(
      presentAccount({
        label: 'System Codex account',
        email: 'me@example.com'
      })
    ).toEqual({
      identity: 'me@example.com',
      provenance: 'Local',
      tooltip: 'me@example.com · This computer'
    })
    // A row still carrying the generated placeholder collapses to "Default account".
    expect(presentAccount({ label: 'New Codex account' }).identity).toBe('Default account')
    // The provenance/tooltip must never leak the credential-storage kind.
    const t = presentAccount({ label: 'New Codex account' }).tooltip
    expect(t).not.toMatch(/managed|system/i)
  })

  it('uses one SSH provenance format with the friendly machine name', () => {
    expect(
      presentAccount({
        email: 'remote@example.com',
        host: 'corvin@devbox',
        machineLabel: 'Ubuntu WSL'
      })
    ).toEqual({
      identity: 'remote@example.com',
      provenance: 'SSH · Ubuntu WSL',
      tooltip: 'remote@example.com · SSH corvin@devbox'
    })
  })

  it('falls back to the raw host when no friendly machine label is saved', () => {
    // The `host ?` branch is provenance's load-bearing local/SSH split — with the machineLabel
    // absent the raw `user@host` must still read as SSH, never as Local.
    expect(presentAccount({ email: 'r@x', host: 'me@box' }).provenance).toBe('SSH · me@box')
  })
})
