import fs from 'fs'
import os from 'os'
import path from 'path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  PLUGIN_MARKER,
  buildOpencodePlugin,
  installOpencodeHooks,
  opencodeConfigDir,
  pluginPath,
  removeOpencodeHooks
} from './opencode'

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

describe('opencodeConfigDir honors XDG_CONFIG_HOME', () => {
  it('lands the plugin under $XDG_CONFIG_HOME/opencode when the (absolute) env var is set', () => {
    const xdg = fs.mkdtempSync(path.join(os.tmpdir(), 'nt-xdg-'))
    vi.stubEnv('XDG_CONFIG_HOME', xdg)
    try {
      expect(opencodeConfigDir()).toBe(path.join(xdg, 'opencode'))
      expect(pluginPath()).toBe(path.join(xdg, 'opencode', 'plugins', 'nodeterm-status.js'))
      installOpencodeHooks()
      const body = fs.readFileSync(path.join(xdg, 'opencode', 'plugins', 'nodeterm-status.js'), 'utf8')
      expect(body.startsWith(PLUGIN_MARKER)).toBe(true)
      // and NOT under ~/.config
      expect(fs.existsSync(path.join(tmp, '.config', 'opencode', 'plugins', 'nodeterm-status.js'))).toBe(false)
    } finally {
      vi.unstubAllEnvs()
      fs.rmSync(xdg, { recursive: true, force: true })
    }
  })
  it('falls back to ~/.config/opencode when XDG_CONFIG_HOME is unset', () => {
    vi.stubEnv('XDG_CONFIG_HOME', '')
    try {
      expect(opencodeConfigDir()).toBe(path.join(tmp, '.config', 'opencode'))
      expect(pluginPath()).toBe(path.join(tmp, '.config', 'opencode', 'plugins', 'nodeterm-status.js'))
    } finally {
      vi.unstubAllEnvs()
    }
  })
})
