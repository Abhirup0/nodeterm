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

  it('open-browser requires --url', () => {
    expect(parseControlRequest('open-browser', {})).toEqual({ error: 'open-browser requires --url' })
    expect(parseControlRequest('open-browser', { url: 'https://x.dev' })).toEqual({
      verb: 'open-browser',
      args: { url: 'https://x.dev' }
    })
  })
  it('open-browser is not destructive', () => {
    expect(isDestructiveVerb('open-browser')).toBe(false)
  })

  it('classifies destructive verbs', () => {
    expect(isDestructiveVerb('write')).toBe(true)
    expect(isDestructiveVerb('close')).toBe(true)
    expect(isDestructiveVerb('open-claude')).toBe(false)
    expect(isDestructiveVerb('show-image')).toBe(false)
  })

  it('group/arrange require --nodes; align also requires --edge', () => {
    expect(parseControlRequest('group', {})).toEqual({ error: 'group requires --nodes <id,id>' })
    expect(parseControlRequest('group', { nodes: 'a,b' })).toEqual({ verb: 'group', args: { nodes: 'a,b' } })
    expect(parseControlRequest('arrange', {})).toEqual({ error: 'arrange requires --nodes <id,id>' })
    expect(parseControlRequest('align', { nodes: 'a' })).toEqual({ error: 'align requires --edge' })
    expect(parseControlRequest('align', { nodes: 'a', edge: 'left' })).toEqual({
      verb: 'align',
      args: { nodes: 'a', edge: 'left' }
    })
  })
  it('rename requires --node and --title, and is not destructive', () => {
    expect(parseControlRequest('rename', {})).toEqual({ error: 'rename requires --node <id>' })
    expect(parseControlRequest('rename', { node: 'n1' })).toEqual({ error: 'rename requires --title' })
    expect(parseControlRequest('rename', { node: 'n1', title: 'Feature Development' })).toEqual({
      verb: 'rename',
      args: { node: 'n1', title: 'Feature Development' }
    })
    expect(isDestructiveVerb('rename')).toBe(false)
  })

  it('spawn-team requires --team and none of the layout verbs are destructive', () => {
    expect(parseControlRequest('spawn-team', {})).toEqual({ error: 'spawn-team requires --team <json>' })
    expect(parseControlRequest('spawn-team', { team: '[]' })).toEqual({ verb: 'spawn-team', args: { team: '[]' } })
    for (const v of ['group', 'arrange', 'align', 'spawn-team'] as const) {
      expect(isDestructiveVerb(v)).toBe(false)
    }
  })
})
