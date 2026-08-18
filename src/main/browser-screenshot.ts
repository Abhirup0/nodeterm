/**
 * `--screenshot <path>` (PR 9 Task 9.1). Capture the guest's page and write a PNG to a caller-named
 * path — and that path is the whole risk: UNJAILED, this is an arbitrary-file-write primitive with
 * attacker-chosen PNG content. So the path is DATA, resolved against the project cwd and refused if it
 * escapes: `..`, an absolute path outside the project, or a symlink whose parent resolves outside.
 *
 * The jail is `fs.realpath` on the target's PARENT (the file does not exist yet — we are about to
 * write it) compared to the canonicalized project root with a SEPARATOR-TERMINATED prefix, so
 * `/proj-evil` never passes the `/proj` check. A final-component symlink (planted at the exact target
 * name, pointing outside) is caught by an `lstat` belt. Only the format `png` is issued, and the
 * `clip` comes from OUR OWN box model (the layout metrics), never from agent input.
 *
 * Main-side only (it holds a debugger and writes a real file); never Server Edition.
 */
import path from 'node:path'
import type { Driver, ActionResult } from './browser-actions'

/** Refused: the resolved path (or a symlink on the way to it) is not inside the project directory. */
export const SCREENSHOT_OUTSIDE_PROJECT =
  'browser: --screenshot path must be inside the project directory'

/** Refused: this canvas/project has no working directory to jail a path to (an inline/no-cwd project). */
export const SCREENSHOT_NO_PROJECT_DIR =
  'browser: --screenshot needs a project folder (this canvas has none)'

/** The filesystem the jail consults, injected so the traversal refusals are unit-testable without a
 *  real tree (a fake `realpath` models a symlink whose parent resolves outside). */
export interface ScreenshotPathDeps {
  /** Canonicalize a path, following every symlink. Rejects when the path does not exist. */
  realpath(p: string): Promise<string>
  /** lstat WITHOUT following the final link — used to refuse a final-component symlink. */
  lstat(p: string): Promise<{ isSymbolicLink(): boolean }>
}

export type ResolvedScreenshotPath = { ok: true; abs: string } | { ok: false; message: string }

/**
 * Resolve a caller-supplied screenshot path into a concrete absolute path INSIDE the project, or a
 * named refusal. Pure of capture/IO beyond the injected `realpath`/`lstat`.
 */
export async function resolveScreenshotPath(
  projectCwd: string | undefined,
  rawPath: string,
  deps: ScreenshotPathDeps
): Promise<ResolvedScreenshotPath> {
  if (!projectCwd) return { ok: false, message: SCREENSHOT_NO_PROJECT_DIR }
  // A relative path resolves against the project cwd; an absolute path stays absolute (and is refused
  // below unless it already lands inside the project).
  const abs = path.resolve(projectCwd, rawPath)
  const parent = path.dirname(abs)
  let realBase: string
  let realParent: string
  try {
    realBase = await deps.realpath(projectCwd)
    // realpath the PARENT — following every link — so a symlink whose parent resolves outside the
    // project is caught. The file itself does not exist yet, so we cannot realpath it directly.
    realParent = await deps.realpath(parent)
  } catch {
    return { ok: false, message: SCREENSHOT_OUTSIDE_PROJECT }
  }
  // Separator-terminated prefix: `/proj-evil` must NOT pass the `/proj` check. Equality is the root
  // itself (a file written directly in the project dir).
  const baseWithSep = realBase.endsWith(path.sep) ? realBase : realBase + path.sep
  if (realParent !== realBase && !realParent.startsWith(baseWithSep)) {
    return { ok: false, message: SCREENSHOT_OUTSIDE_PROJECT }
  }
  const target = path.join(realParent, path.basename(abs))
  // Belt against a final-component symlink planted at the exact target name pointing outside: a
  // plain writeFile would follow it. A missing file (ENOENT) is the normal case and passes.
  try {
    const st = await deps.lstat(target)
    if (st.isSymbolicLink()) return { ok: false, message: SCREENSHOT_OUTSIDE_PROJECT }
  } catch {
    /* does not exist yet — the expected case for a new screenshot */
  }
  return { ok: true, abs: target }
}

/** The IO the action needs beyond the jail: capture goes through the gated `Driver.send`; the file
 *  write is injected so the action is testable without touching disk. */
export interface ScreenshotDeps extends ScreenshotPathDeps {
  writeFile(p: string, data: Buffer): Promise<void>
}

/**
 * `--screenshot <path>` with the optional `--full true` modifier. Jail the path, measure the page
 * from OUR layout metrics, capture a PNG (viewport by default, the whole content box with `--full`),
 * write it, and reply with the path, dimensions, size, and the exact `show-image` line the agent can
 * echo to put the shot on the canvas.
 */
export async function browserScreenshot(
  s: Driver,
  nodeId: string,
  projectCwd: string | undefined,
  rawPath: string,
  opts: { full?: boolean },
  deps: ScreenshotDeps
): Promise<ActionResult> {
  const resolved = await resolveScreenshotPath(projectCwd, rawPath, deps)
  if (!resolved.ok) return { ok: false, message: resolved.message }
  const m = await s.refreshViewport()
  const full = opts.full === true
  // The clip is OURS — from the measured page, never a caller field. Default is the visible viewport
  // (no clip); --full captures the whole content box.
  const params = full
    ? {
        format: 'png',
        captureBeyondViewport: true,
        clip: {
          x: 0,
          y: 0,
          width: Math.round(m.contentWidth),
          height: Math.round(m.contentHeight),
          scale: 1
        }
      }
    : { format: 'png' }
  const res = (await s.send('Page.captureScreenshot', params)) as { data?: unknown }
  const b64 = typeof res?.data === 'string' ? res.data : ''
  if (!b64) return { ok: false, message: `browser: ${nodeId} returned no screenshot data` }
  const buf = Buffer.from(b64, 'base64')
  try {
    await deps.writeFile(resolved.abs, buf)
  } catch {
    return { ok: false, message: `browser: could not write the screenshot to ${resolved.abs}` }
  }
  const w = full ? Math.round(m.contentWidth) : Math.round(m.width)
  const h = full ? Math.round(m.contentHeight) : Math.round(m.height)
  const kb = Math.max(1, Math.round(buf.length / 1024))
  return {
    ok: true,
    message: `wrote ${resolved.abs} (${w}×${h}, ${kb} KB) — show it with: show-image ${resolved.abs}`
  }
}
