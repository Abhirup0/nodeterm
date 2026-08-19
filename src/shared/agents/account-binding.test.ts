import { describe, it, expect } from 'vitest'
import { boundAccountId } from './account-binding'

describe('boundAccountId', () => {
  it('binds a managed account to a Claude node', () => {
    expect(boundAccountId('a1', 'claude')).toBe('a1')
  })

  it('binds a managed account to a Codex node — accounts are not Claude-only since S6', () => {
    expect(boundAccountId('c1', 'codex')).toBe('c1')
  })

  it('never binds one to a builtin that takes no managed account', () => {
    expect(boundAccountId('a1', 'gemini')).toBeUndefined()
    expect(boundAccountId('a1', 'grok')).toBeUndefined()
  })

  it('never binds one to a custom agent, even one based on claude or codex', () => {
    // A custom agent inheriting a builtin's harness is still its own agent; account binding stays
    // with the builtin the account picker offered it for, exactly as createAgentNode has always
    // had it.
    expect(boundAccountId('a1', 'my-claude')).toBeUndefined()
    expect(boundAccountId('c1', 'my-codex')).toBeUndefined()
  })

  it('keeps the binding when the agent is not stated at all', () => {
    // The phone chooses `agentId` and `accountId` independently and whether it always sends the
    // first alongside the second is an OPEN question (docs/ios-protocol-migration.md §6). Dropping
    // a real Claude binding is the severe direction — it is the wrong-identity bug the field
    // exists to prevent — while keeping a stray one on an agent-less node only sets a config-home
    // variable nothing reads.
    expect(boundAccountId('a1', undefined)).toBe('a1')
  })

  it('is undefined when no account is given', () => {
    expect(boundAccountId(undefined, 'claude')).toBeUndefined()
    expect(boundAccountId('', 'claude')).toBeUndefined()
  })
})
