import { describe, it, expect } from 'vitest'
import { parseControlRequest, isDestructiveVerb } from './canvas-control-core'

describe('parseControlRequest', () => {
  it('accepts known verbs', () => {
    expect(parseControlRequest('list', {})).toEqual({ verb: 'list', args: {} })
    expect(parseControlRequest('open-claude', { count: '2' })).toEqual({
      verb: 'open-claude',
      args: { count: '2' }
    })
  })

  it('rejects unknown verbs', () => {
    expect(parseControlRequest('nuke', {})).toEqual({ error: 'Unknown verb: nuke' })
  })

  it('requires a target for write/close', () => {
    expect(parseControlRequest('close', {})).toEqual({ error: 'close requires --node <id>' })
    expect(parseControlRequest('write', { node: 'n1' })).toEqual({ error: 'write requires --text' })
    expect(parseControlRequest('write', { node: 'n1', text: 'hi' })).toEqual({
      verb: 'write',
      args: { node: 'n1', text: 'hi' }
    })
  })

  it('requires a source for show verbs', () => {
    expect(parseControlRequest('show-video', {})).toEqual({ error: 'show-video requires --path' })
    expect(parseControlRequest('show-web', {})).toEqual({
      error: 'show-web requires --url, --file or --html'
    })
  })

  it('classifies destructive verbs', () => {
    expect(isDestructiveVerb('write')).toBe(true)
    expect(isDestructiveVerb('close')).toBe(true)
    expect(isDestructiveVerb('open-claude')).toBe(false)
    expect(isDestructiveVerb('show-image')).toBe(false)
  })
})
