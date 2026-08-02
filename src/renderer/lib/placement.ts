// Where to drop a NEW node when there is no cursor to place it at (the kanban board's "+ New
// session", the dock's add menu, the command palette). Those all fell back to the view center, so
// every node created that way piled up on the same spot — switch to the canvas and you'd find a
// stack of overlapping nodes. `freeSpot` instead finds the nearest empty position.

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/**
 * The nearest position (to `preferred`) where a `size` box does not overlap any of `existing`,
 * searched outward on a grid stepped by the node size. Returns `preferred` unchanged when it's
 * already clear (so a lone node / an empty canvas keeps the centered placement). Pure + testable.
 *
 * `gap` is the minimum breathing room kept between boxes. The ring search is capped so a pathological
 * canvas can never loop forever — past the cap it gives up and returns `preferred` (overlap is a far
 * lesser evil than a hang).
 */
export function freeSpot(
  existing: Box[],
  preferred: { x: number; y: number },
  size: { w: number; h: number },
  gap = 28
): { x: number; y: number } {
  const clear = (x: number, y: number): boolean =>
    !existing.some(
      (b) =>
        x < b.x + b.w + gap &&
        x + size.w + gap > b.x &&
        y < b.y + b.h + gap &&
        y + size.h + gap > b.y
    )

  if (clear(preferred.x, preferred.y)) return preferred

  const stepX = size.w + gap
  const stepY = size.h + gap
  // Expanding square rings around `preferred`; within a ring, walk the perimeter and take the first
  // clear cell. Nearest-first keeps new nodes close to where the user is looking.
  for (let ring = 1; ring <= 60; ring++) {
    for (let dy = -ring; dy <= ring; dy++) {
      for (let dx = -ring; dx <= ring; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue // perimeter only
        const x = preferred.x + dx * stepX
        const y = preferred.y + dy * stepY
        if (clear(x, y)) return { x, y }
      }
    }
  }
  return preferred
}
