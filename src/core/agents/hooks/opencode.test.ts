import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { PLUGIN_MARKER, buildOpencodePlugin, installOpencodeHooks, removeOpencodeHooks } from './opencode'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-oc-'))
  vi.spyOn(os, 'homedir').mockReturnValue(tmp)
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

const planted = () => path.join(tmp, '.config', 'opencode', 'plugins', 'nodeterm-status.js')

describe('opencode plugin install', () => {
  it('writes the marker-bearing plugin file (idempotent)', () => {
    installOpencodeHooks()
    installOpencodeHooks()
    const body = fs.readFileSync(planted(), 'utf8')
    expect(body.startsWith(PLUGIN_MARKER)).toBe(true)
    expect(body).toContain('NODETERM_NODE_ID')
    expect(body).toContain('/hook/opencode')
  })
  it('never overwrites a user file without the marker', () => {
    fs.mkdirSync(path.dirname(planted()), { recursive: true })
    fs.writeFileSync(planted(), '// my own plugin\n')
    installOpencodeHooks()
    expect(fs.readFileSync(planted(), 'utf8')).toBe('// my own plugin\n')
  })
  it('remove deletes only a marker-bearing file', () => {
    installOpencodeHooks()
    removeOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(false)
    fs.mkdirSync(path.dirname(planted()), { recursive: true })
    fs.writeFileSync(planted(), '// my own plugin\n')
    removeOpencodeHooks()
    expect(fs.existsSync(planted())).toBe(true)
  })
  it('generated plugin is env-gated and fail-open', () => {
    const body = buildOpencodePlugin()
    expect(body).toContain('return {}') // missing env → no-op
    expect(body).toContain('catch') // POSTs never throw into opencode
  })
})
