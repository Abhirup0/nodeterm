export interface ReopenNodeSnapshot {
  type: string
  position: { x: number; y: number }
  absolutePosition: { x: number; y: number }
  data: Record<string, unknown>
}
