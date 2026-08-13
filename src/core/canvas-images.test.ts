import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'fs'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { appImagesDir, canvasImageTarget, projectImagesDir, saveCanvasImage } from './canvas-images'
import { uploadsRoot } from './uploads'

const png = Buffer.from('fake-png-bytes').toString('base64')

let root: string
let userDataDir: string
let projectCwd: string

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'nt-canvas-images-'))
  userDataDir = join(root, 'userData')
  projectCwd = join(root, 'project')
  await fs.mkdir(projectCwd, { recursive: true })
})
afterEach(() => rm(root, { recursive: true, force: true }))

describe('canvasImageTarget', () => {
  it('uses the project folder when it has a local cwd, and a durable app folder when it does not', () => {
    expect(canvasImageTarget(projectCwd, userDataDir)).toEqual({
      dir: projectImagesDir(projectCwd),
      inProject: true
    })
    // No local cwd: an SSH project (its cwd is on the host), a relay tab, or an inline canvas.
    expect(canvasImageTarget(undefined, userDataDir)).toEqual({
      dir: appImagesDir(userDataDir),
      inProject: false
    })
  })

  it('never lands inside the swept uploads staging area', () => {
    // The whole reason this module exists: a canvas image node is persisted, so its file must not
    // sit where UPLOAD_TTL_MS deletes it after a week.
    const sweptRoot = uploadsRoot(userDataDir)
    expect(canvasImageTarget(projectCwd, userDataDir).dir.startsWith(sweptRoot)).toBe(false)
    expect(canvasImageTarget(undefined, userDataDir).dir.startsWith(sweptRoot)).toBe(false)
  })
})

describe('saveCanvasImage', () => {
  it('writes into the project’s git-shared .nodeterm/images/', async () => {
    const path = await saveCanvasImage({
      projectCwd,
      userDataDir,
      name: 'shot.png',
      dataBase64: png
    })
    expect(path).toBe(join(projectCwd, '.nodeterm', 'images', 'shot.png'))
    expect(await fs.readFile(path!, 'utf8')).toBe('fake-png-bytes')
  })

  it('falls back to the app folder for a project with no local cwd, instead of refusing', async () => {
    const path = await saveCanvasImage({ userDataDir, name: 'shot.png', dataBase64: png })
    expect(path).toBe(join(appImagesDir(userDataDir), 'shot.png'))
    expect(await fs.readFile(path!, 'utf8')).toBe('fake-png-bytes')
  })

  it('never clobbers an existing image, and keeps the extension on the renamed one', async () => {
    const first = await saveCanvasImage({ projectCwd, userDataDir, name: 'shot.png', dataBase64: png })
    const second = await saveCanvasImage({
      projectCwd,
      userDataDir,
      name: 'shot.png',
      dataBase64: Buffer.from('second').toString('base64')
    })
    expect(first).toBe(join(projectCwd, '.nodeterm', 'images', 'shot.png'))
    expect(second).toBe(join(projectCwd, '.nodeterm', 'images', 'shot (2).png'))
    expect(await fs.readFile(first!, 'utf8')).toBe('fake-png-bytes')
    expect(await fs.readFile(second!, 'utf8')).toBe('second')
  })

  it('cannot be steered out of the images directory by the pasted name', async () => {
    const path = await saveCanvasImage({
      projectCwd,
      userDataDir,
      name: '../../.bashrc',
      dataBase64: png
    })
    expect(path).toBe(join(projectCwd, '.nodeterm', 'images', '.bashrc'))
    await expect(fs.readFile(join(root, '.bashrc'), 'utf8')).rejects.toThrow()
  })

  it('answers null for bytes it will not store, rather than throwing', async () => {
    expect(await saveCanvasImage({ projectCwd, userDataDir, name: 'a.png', dataBase64: '' })).toBe(
      null
    )
    expect(
      await saveCanvasImage({
        projectCwd,
        userDataDir,
        name: 'a.png',
        dataBase64: 'x'.repeat(64 * 1024 * 1024 * 2)
      })
    ).toBe(null)
  })
})
