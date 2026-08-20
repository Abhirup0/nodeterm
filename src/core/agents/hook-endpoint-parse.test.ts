import { describe, it, expect } from 'vitest'
import { parseEndpointEnv } from './hook-endpoint-parse'
import { posixQuote } from '../../shared/ssh'

describe('parseEndpointEnv', () => {
  it('unquotes the exact posixQuote form both writers emit (spaced macOS path, #351)', () => {
    const dir = '/Users/work/Library/Application Support/node-terminal/node-tokens'
    // Built with the SAME posixQuote the writers use — not a hand-approximated fixture.
    const body =
      `NODETERM_HOOK_PORT=${posixQuote('54321')}\n` +
      `NODETERM_HOOK_TOKEN=${posixQuote('08011abf-af79')}\n` +
      `NODETERM_HOOK_VERSION=${posixQuote('2')}\n` +
      `NODETERM_NODE_TOKEN_DIR=${posixQuote(dir)}\n`
    expect(parseEndpointEnv(body)).toEqual({
      NODETERM_HOOK_PORT: '54321',
      NODETERM_HOOK_TOKEN: '08011abf-af79',
      NODETERM_HOOK_VERSION: '2',
      NODETERM_NODE_TOKEN_DIR: dir
    })
  })

  it('still parses a LEGACY unquoted file verbatim (pre-fix build; stale files are a real state)', () => {
    const body =
      'NODETERM_HOOK_SOCK=/home/u/.nodeterm/hook-p1.sock\n' +
      'NODETERM_HOOK_TOKEN=tok\n' +
      'NODETERM_NODE_TOKEN_DIR=/home/u/.nodeterm/node-tokens\n'
    expect(parseEndpointEnv(body)).toEqual({
      NODETERM_HOOK_SOCK: '/home/u/.nodeterm/hook-p1.sock',
      NODETERM_HOOK_TOKEN: 'tok',
      NODETERM_NODE_TOKEN_DIR: '/home/u/.nodeterm/node-tokens'
    })
  })

  it("round-trips an embedded single quote (posixQuote's '\\'' escape)", () => {
    const value = "it's a 'weird' $token; `x`"
    expect(parseEndpointEnv(`K=${posixQuote(value)}\n`).K).toBe(value)
    // Quote at the very edge of the value.
    expect(parseEndpointEnv(`K=${posixQuote("'")}\n`).K).toBe("'")
    expect(parseEndpointEnv(`K=${posixQuote("a'")}\n`).K).toBe("a'")
  })

  it('keeps values containing "=" whole (first-= split) and skips malformed lines', () => {
    const env = parseEndpointEnv(`A=${posixQuote('x=y')}\nB=x=y\n\nnot a line\n=nope\n`)
    expect(env).toEqual({ A: 'x=y', B: 'x=y' })
  })

  it('is self-contained, so the opencode plugin can embed it via toString()', () => {
    const src = parseEndpointEnv.toString()
    // Must not close over anything or use template literals — the plugin inlines this source.
    expect(src).not.toContain('`')
    expect(src).not.toContain('${')
    // eslint-disable-next-line no-eval
    const embedded = (0, eval)(`(${src})`) as typeof parseEndpointEnv
    expect(embedded(`K=${posixQuote('a b')}\n`).K).toBe('a b')
  })
})
