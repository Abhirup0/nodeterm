// A tiny seam so code OUTSIDE Canvas can trigger the same debounced workspace save Canvas owns.
// Canvas registers its `markDirty`; other surfaces (a canvas node editing its kanban labels) call
// `markWorkspaceDirty()`. No-op when nothing is registered (boot before Canvas mounts, tests).

let cb: (() => void) | null = null

/** Canvas calls this on mount with its markDirty; the returned fn unregisters on unmount. */
export function registerWorkspaceDirty(fn: () => void): () => void {
  cb = fn
  return () => {
    if (cb === fn) cb = null
  }
}

/** Trigger the debounced workspace save from anywhere in the renderer. */
export function markWorkspaceDirty(): void {
  cb?.()
}
