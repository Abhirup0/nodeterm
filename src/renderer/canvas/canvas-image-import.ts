/** True only for the actual React Flow pane, never flow-wrap overlays such as Welcome/Usage. */
export function isCanvasImageDropTarget(target: EventTarget | null, wrap: Element): boolean {
  const element = target instanceof Element ? target : null
  return !!(
    element &&
    wrap.contains(element) &&
    element.closest('.react-flow__pane') &&
    !element.closest('.react-flow__node, .react-flow__controls, .react-flow__minimap')
  )
}

export interface CanvasImagePlacement {
  filePath: string
  center: { x: number; y: number }
}

/**
 * Keyboard-opened UI must revoke a prior canvas click. Modifier keydown events are part of the
 * normal Cmd+V sequence, so only they and the actual paste chord preserve the armed state.
 */
export function canvasImagePasteArmedAfterKey(
  armed: boolean,
  event: { key: string; metaKey: boolean; ctrlKey: boolean }
): boolean {
  if (!armed) return false
  if (event.key === 'Meta' || event.key === 'Control' || event.key === 'Alt' || event.key === 'Shift') {
    return true
  }
  return (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'v'
}

/** Resolve image files asynchronously, but abandon them if their originating project changed. */
export async function guardedCanvasImagePlacements(
  resolvePaths: () => Promise<string[]>,
  originatingProjectId: string,
  activeProjectId: () => string,
  center: { x: number; y: number }
): Promise<CanvasImagePlacement[]> {
  const paths = await resolvePaths()
  if (activeProjectId() !== originatingProjectId) return []
  return paths.map((filePath, index) => ({
    filePath,
    center: { x: center.x + index * 36, y: center.y + index * 36 }
  }))
}
