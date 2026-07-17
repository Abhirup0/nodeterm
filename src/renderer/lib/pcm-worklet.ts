/**
 * AudioWorkletProcessor that ships raw mono PCM frames to the main thread.
 *
 * Runs in the AudioWorkletGlobalScope, not the DOM/window scope: no imports
 * from the rest of the renderer, no React, nothing that assumes `window`.
 * The base lib (`lib.dom.d.ts`) does not declare this scope's globals
 * (`AudioWorkletProcessor`, `registerProcessor`), so they're declared
 * ambiently below, file-local, rather than widening a shared lib config
 * for one file.
 *
 * Bundling: loaded by `PcmCapture` via
 * `new URL('./pcm-worklet.ts', import.meta.url)` passed to
 * `audioContext.audioWorklet.addModule(url)`. electron-vite (Vite) resolves
 * that `new URL(..., import.meta.url)` pattern at build time and emits this
 * file as its own same-origin asset — no bundler-specific worker syntax
 * needed here, unlike the `?worker` Monaco pattern (that instantiates a
 * `Worker` object; `addModule` wants a URL string/URL to fetch instead). The
 * asset is served same-origin, which satisfies CSP `worker-src 'self'
 * blob:'`.
 */

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: unknown) => AudioWorkletProcessorLike
): void

interface AudioWorkletProcessorLike {
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean
}

declare class AudioWorkletProcessor implements AudioWorkletProcessorLike {
  readonly port: MessagePort
  constructor()
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters: Record<string, Float32Array>
  ): boolean
}

/** Name used on both sides of `audioWorklet.addModule` / `new AudioWorkletNode(ctx, name)`. */
export const PCM_WORKLET_NAME = 'pcm-capture'

class PcmCaptureProcessor extends AudioWorkletProcessor {
  process(inputs: Float32Array[][]): boolean {
    const channel0 = inputs[0]?.[0]
    // No input yet (device warming up) or the graph was torn down mid-block —
    // keep the processor alive rather than posting nothing.
    if (channel0 && channel0.length > 0) {
      // The Float32Array Web Audio hands us is a scratch buffer the engine
      // reuses next block — copy it (structured clone across postMessage
      // does this too, but .slice() makes the ownership explicit here).
      this.port.postMessage(channel0.slice())
    }
    return true
  }
}

registerProcessor(PCM_WORKLET_NAME, PcmCaptureProcessor)
