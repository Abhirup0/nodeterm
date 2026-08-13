// Where an image pasted or dropped ONTO THE CANVAS is written.
//
// This is deliberately NOT `core/uploads.ts`. That directory is a staging area for a paste into a
// terminal — the path is consumed within seconds and swept after `UPLOAD_TTL_MS` (7 days), which
// is right for a path that was pasted into a prompt and wrong for a canvas image node: the node is
// persisted in `project.json`, so after a week the canvas kept a node pointing at a file the
// sweeper had deleted. Whatever holds the file has to be at least as durable as the thing that
// remembers it.
//
// So a project with a local cwd gets `<cwd>/.nodeterm/images/`, beside the `project.json` that
// names the node. That folder is already the git-shared one (project.json, board-log.jsonl), so
// the image travels to everyone who clones the repo — which is the point: a canvas that arrives
// with broken image nodes is a canvas that did not arrive.
//
// Everything else falls back to `<userData>/canvas-images/` — durable (no sweeper walks it) but
// local to this machine. See `canvasImageTarget` for exactly which cases, and why.

import { promises as fs } from 'fs'
import { join } from 'path'
import { candidateName } from './download-name'
import { UPLOAD_MAX_BYTES, safeUploadName } from './uploads'

/** Beside project.json, in the git-shared folder — so the image travels with the canvas. */
export const projectImagesDir = (projectCwd: string): string =>
  join(projectCwd, '.nodeterm', 'images')

/** The fallback for a project with no local cwd. Outside `uploads/`, so no sweeper touches it. */
export const appImagesDir = (userDataDir: string): string => join(userDataDir, 'canvas-images')

/** Give up rather than spin: 200 files literally named `shot.png` is not a collision any more. */
const MAX_COLLISION_ATTEMPTS = 200

export interface CanvasImageTarget {
  dir: string
  /** True when the file landed in the project (and will therefore travel with it). */
  inProject: boolean
}

/**
 * `projectCwd` is the project's LOCAL cwd, or undefined. Undefined covers three cases, and the
 * answer is the same for all of them because in each one there is no local directory that both
 * this machine can write and the image node can later read:
 *
 *  • a cwd-less / inline canvas — there is no project folder at all;
 *  • an SSH project — `<cwd>` is a path on the REMOTE host, and `files.saveUpload` has always
 *    written on the machine the terminals run on, i.e. here. The image node itself reads locally
 *    (the canvas opens it without `sshFs`), so writing the bytes to the host would produce a node
 *    that cannot read its own file;
 *  • a relay tab — not in this machine's workspace index at all.
 *
 * None of these is an error, so none of them refuses: the image is still saved, just somewhere
 * that only this machine can see. The caller is told which happened via `inProject`.
 */
export function canvasImageTarget(
  projectCwd: string | undefined,
  userDataDir: string
): CanvasImageTarget {
  return projectCwd
    ? { dir: projectImagesDir(projectCwd), inProject: true }
    : { dir: appImagesDir(userDataDir), inProject: false }
}

/**
 * Write base64 `data` into the project's image folder and resolve its ABSOLUTE path, or null when
 * it could not be written (too large, undecodable, unwritable, or a name that collided 200 times).
 * Never throws — the caller drops what it could not save, exactly like a failed drop.
 *
 * The name is basenamed by `safeUploadName` before it is joined, so a pasted `../../.bashrc`
 * cannot escape the directory, and the write is an EXCLUSIVE create (`wx`) walked through
 * `candidateName` — so a second `shot.png` becomes `shot (2).png` instead of overwriting the
 * first, and there is no stat-then-write window for two pastes to both win.
 */
export async function saveCanvasImage(opts: {
  projectCwd?: string
  userDataDir: string
  name: string
  dataBase64: string
}): Promise<string | null> {
  try {
    // Guard the ENCODED length first: decoding a hostile 2 GB string to measure it is the
    // allocation this limit exists to prevent (same rule as core/uploads.ts).
    const { dataBase64 } = opts
    if (typeof dataBase64 !== 'string' || dataBase64.length > UPLOAD_MAX_BYTES * 1.4) return null
    const buf = Buffer.from(dataBase64, 'base64')
    if (!buf.length || buf.length > UPLOAD_MAX_BYTES) return null

    const { dir } = canvasImageTarget(opts.projectCwd, opts.userDataDir)
    await fs.mkdir(dir, { recursive: true })
    const safe = safeUploadName(opts.name)
    for (let attempt = 1; attempt <= MAX_COLLISION_ATTEMPTS; attempt++) {
      const target = join(dir, candidateName(safe, attempt))
      try {
        await fs.writeFile(target, buf, { flag: 'wx' })
        return target
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code !== 'EEXIST') throw err
      }
    }
    return null
  } catch {
    return null
  }
}
