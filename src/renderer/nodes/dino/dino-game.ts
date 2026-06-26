import { Runner } from './trex-runner'
import { DINO_SOUNDS } from './sounds'
import sprite1x from './sprite-1x.png'
import sprite2x from './sprite-2x.png'

/**
 * Mounts a T-Rex Runner game inside `host`. The vendored engine resolves its
 * resources from the document by FIXED ids: sprite <img> elements
 * (`offline-resources-1x` / `-2x`, picked by devicePixelRatio) loaded at
 * construction, and sound <audio> elements read on first play from a
 * <template id="audio-resources">.content. It mounts its own <canvas> into the
 * selector we hand it and binds keydown/keyup/mouse on document. We build that
 * scaffold scoped under `host`, give the wrapper a unique selector, and tear it
 * all down on destroy(). The engine keeps its own high score; we mirror it out.
 */
export function createDinoGame(
  host: HTMLElement,
  opts: { initialHighScore: number; onHighScore: (score: number) => void }
): { destroy: () => void } {
  // Unique class so multiple dino nodes don't collide on the engine's selector.
  const wrapperClass = `dino-wrapper-${Math.floor(performance.now())}-${Math.round(Math.random() * 1e6)}`

  // --- Sprite resources: loose <img> by fixed id (engine uses getElementById).
  const makeSprite = (id: string, src: string): HTMLImageElement => {
    const el = document.createElement('img')
    el.id = id
    el.src = src
    el.style.display = 'none'
    return el
  }
  const sprites: HTMLImageElement[] = [
    makeSprite('offline-resources-1x', sprite1x),
    makeSprite('offline-resources-2x', sprite2x)
  ]
  sprites.forEach((el) => host.appendChild(el))

  // --- Sound resources: MUST live inside a <template id="audio-resources">.
  // The engine reads `getElementById('audio-resources').content` then
  // `.getElementById('offline-sound-*')` on first play; loose <audio> would
  // throw. The src must carry the `data:audio/mpeg;base64,` prefix — loadSounds
  // strips everything up to the comma before decoding.
  const template = document.createElement('template')
  template.id = 'audio-resources'
  const makeAudio = (id: string, b64: string): HTMLAudioElement => {
    const el = document.createElement('audio')
    el.id = id
    el.src = `data:audio/mpeg;base64,${b64}`
    return el
  }
  template.content.appendChild(makeAudio('offline-sound-press', DINO_SOUNDS.press))
  template.content.appendChild(makeAudio('offline-sound-hit', DINO_SOUNDS.hit))
  template.content.appendChild(makeAudio('offline-sound-reached', DINO_SOUNDS.reached))
  host.appendChild(template)

  // The engine's init() does `document.querySelector('.icon-offline').style…`
  // (and setupDisabledRunner uses `.icon`); with no such element the query
  // returns null and `.style` throws from the Runner constructor → blank node.
  // A single hidden element satisfying BOTH selectors keeps init() happy.
  const icon = document.createElement('div')
  icon.className = 'icon icon-offline'
  icon.style.display = 'none'
  host.appendChild(icon)

  // The engine does `document.querySelector(selector)` for its outer container.
  const wrapper = document.createElement('div')
  wrapper.className = wrapperClass
  host.appendChild(wrapper)

  // The constructor returns the existing singleton if one is set; clear it so
  // each node gets its own instance. Do NOT pass opt_config — the engine would
  // REPLACE (not merge) its default config and break.
  Runner.instance_ = undefined
  const runner = new Runner(`.${wrapperClass}`)

  // Seed the engine's persisted high score with ours (it reflects it in its own
  // on-canvas HI after the first run/crash), then poll for new records and
  // report them out — the engine has no high-score callback.
  let best = opts.initialHighScore
  runner.highestScore = best
  const poll = window.setInterval(() => {
    const hs = Math.round(runner.highestScore)
    if (hs > best) {
      best = hs
      opts.onHighScore(best)
    }
  }, 1000)

  return {
    destroy() {
      window.clearInterval(poll)
      // Separate try blocks so a throw in stop() can't skip stopListening()
      // (which removes the gameplay key listeners — input must not leak).
      try {
        runner.stop()
      } catch {
        /* engine already torn down */
      }
      try {
        // Removes the gameplay keydown/keyup/mouse listeners (engine uses a
        // `handleEvent` method, so removeEventListener(…, this) works).
        ;(runner as unknown as { stopListening: () => void }).stopListening()
      } catch {
        /* engine already torn down */
      }
      // Drop the singleton ref so a fresh node can construct cleanly.
      if (Runner.instance_ === runner) Runner.instance_ = undefined
      wrapper.remove()
      sprites.forEach((el) => el.remove())
      template.remove()
      icon.remove()
      // NOTE: the engine also binds window resize/visibility/blur/focus and one
      // anonymous document keydown that it has no API to remove — an accepted
      // minor leak. stopListening() drops the gameplay keys, which is what
      // matters for input not bleeding into other nodes.
    }
  }
}
