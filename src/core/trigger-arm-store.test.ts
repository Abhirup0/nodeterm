import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { TriggerSpec } from '../shared/trigger'
import { TriggerArmStore } from './trigger-arm-store'

const spec = (payload = 'npm test'): TriggerSpec => ({
  schedule: { kind: 'cron', expr: '0 9 * * *' },
  payload,
  target: 'term-tgt-1'
})

describe('TriggerArmStore', () => {
  let dir: string
  let store: TriggerArmStore

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'nt-trigger-arm-'))
    store = new TriggerArmStore(dir)
    await store.load()
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it('a trigger that just arrived from git is DISARMED — loading a project mints no consent', async () => {
    // The invariant the whole store exists for: nothing in a shared project.json can arm itself.
    // A fresh store (this machine never armed anything) answers false for any spec it is shown.
    expect(store.isArmed('project-1', 'trigger-a-1', spec())).toBe(false)
    expect(store.armedRecord('project-1', 'trigger-a-1')).toBeUndefined()
  })

  it('arm → isArmed → disarm round trip, persisted across a reload', async () => {
    expect(await store.arm('project-1', 'trigger-a-1', spec())).toBe(true)
    expect(store.isArmed('project-1', 'trigger-a-1', spec())).toBe(true)

    const reloaded = new TriggerArmStore(dir)
    await reloaded.load()
    expect(reloaded.isArmed('project-1', 'trigger-a-1', spec())).toBe(true)

    await reloaded.disarm('project-1', 'trigger-a-1')
    expect(reloaded.isArmed('project-1', 'trigger-a-1', spec())).toBe(false)
    const again = new TriggerArmStore(dir)
    await again.load()
    expect(again.isArmed('project-1', 'trigger-a-1', spec())).toBe(false)
  })

  it('the arm binds to CONTENT: a spec edited after arming reads as disarmed', async () => {
    await store.arm('project-1', 'trigger-a-1', spec('npm test'))
    // A git pull rewrote the payload — the old consent must not cover the new content.
    expect(store.isArmed('project-1', 'trigger-a-1', spec('rm -rf /'))).toBe(false)
    // The stale record is still visible so the UI can say "changed since armed".
    expect(store.armedRecord('project-1', 'trigger-a-1')).toBeDefined()
    // The original content is still armed.
    expect(store.isArmed('project-1', 'trigger-a-1', spec('npm test'))).toBe(true)
  })

  it('refuses to arm an invalid spec or unsafe keys, recording nothing', async () => {
    const bad = { ...spec(), payload: '' } as TriggerSpec
    expect(await store.arm('project-1', 'trigger-a-1', bad)).toBe(false)
    expect(store.armedRecord('project-1', 'trigger-a-1')).toBeUndefined()
    expect(await store.arm('p;rm', 'trigger-a-1', spec())).toBe(false)
    expect(await store.arm('project-1', 'bad id', spec())).toBe(false)
  })

  it('an invalid CURRENT spec never reads as armed, whatever is recorded', async () => {
    await store.arm('project-1', 'trigger-a-1', spec())
    const hostile = { ...spec(), payload: 'x\u001b[201~y' } as TriggerSpec
    expect(store.isArmed('project-1', 'trigger-a-1', hostile)).toBe(false)
  })

  it('a corrupt or foreign-shaped file loads as an empty store (all disarmed)', async () => {
    await store.arm('project-1', 'trigger-a-1', spec())
    await fs.writeFile(path.join(dir, 'trigger-arms.json'), 'not json{', 'utf-8')
    const reloaded = new TriggerArmStore(dir)
    await reloaded.load()
    expect(reloaded.isArmed('project-1', 'trigger-a-1', spec())).toBe(false)

    await fs.writeFile(
      path.join(dir, 'trigger-arms.json'),
      JSON.stringify({ version: 99, projects: { p: { n: { armedAt: 1, spec: 's' } } } }),
      'utf-8'
    )
    const wrongVersion = new TriggerArmStore(dir)
    await wrongVersion.load()
    expect(wrongVersion.armedRecord('p', 'n')).toBeUndefined()
  })

  it('drops dangerous or malformed keys and records on load instead of importing them', async () => {
    // Built as a raw string: a `__proto__` key in a JS object literal would set the prototype
    // instead of writing the property, and the point is what a hostile FILE can carry.
    const hostileFile =
      '{"version":1,"projects":{' +
      '"__proto__":{"trigger-a-1":{"armedAt":1,"spec":"s"}},' +
      '"project-1":{' +
      '"bad id":{"armedAt":1,"spec":"s"},' +
      '"trigger-ok-1":{"armedAt":0,"spec":"s"},' +
      '"trigger-a-1":{"armedAt":5,"spec":"canon"}}}}'
    await fs.writeFile(path.join(dir, 'trigger-arms.json'), hostileFile, 'utf-8')
    const reloaded = new TriggerArmStore(dir)
    await reloaded.load()
    expect(reloaded.armedRecord('project-1', 'trigger-a-1')).toEqual({ armedAt: 5, spec: 'canon' })
    expect(reloaded.armedRecord('project-1', 'bad id')).toBeUndefined()
    expect(reloaded.armedRecord('project-1', 'trigger-ok-1')).toBeUndefined()
    expect(reloaded.armedRecord('__proto__', 'trigger-a-1')).toBeUndefined()
    expect(({} as Record<string, unknown>)['trigger-a-1']).toBeUndefined()
  })

  it('prunes dead projects and dead nodes', async () => {
    await store.arm('project-1', 'trigger-a-1', spec())
    await store.arm('project-1', 'trigger-b-1', spec())
    await store.arm('project-2', 'trigger-c-1', spec())

    await store.pruneProjects(['project-1'])
    expect(store.armedRecord('project-2', 'trigger-c-1')).toBeUndefined()
    expect(store.armedRecord('project-1', 'trigger-a-1')).toBeDefined()

    await store.pruneNodes('project-1', ['trigger-a-1'])
    expect(store.armedRecord('project-1', 'trigger-b-1')).toBeUndefined()
    expect(store.armedRecord('project-1', 'trigger-a-1')).toBeDefined()
  })

  it('writes the file with owner-only permissions', async () => {
    await store.arm('project-1', 'trigger-a-1', spec())
    const stat = await fs.stat(path.join(dir, 'trigger-arms.json'))
    if (process.platform !== 'win32') expect(stat.mode & 0o777).toBe(0o600)
  })
})
