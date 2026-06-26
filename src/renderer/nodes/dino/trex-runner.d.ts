export class Runner {
  constructor(outerContainerSelector: string, optConfig?: Record<string, unknown>)
  static instance_: Runner | undefined
  canvas: HTMLCanvasElement
  highestScore: number
  playing: boolean
  stop(): void
  play(): void
}
