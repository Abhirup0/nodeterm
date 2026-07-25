// Retro sound effects for the two agent edges you actually wait on: a turn FINISHING and a session
// NEEDING YOU (permission prompt / question). Synthesized with WebAudio — no audio assets, so
// there's nothing to bundle, license or keep in sync, and the tone is tunable in code.
//
// Two distinct voices on purpose (owner's call): "done" is a short rising 8-bit arpeggio (the
// pac-man pellet register), "needs you" is a crackly glitch bleep — you can tell them apart without
// looking at the screen. Both are < 300 ms and deliberately quiet.
//
// Three surfaces: this is pure renderer, so desktop AND the browser Server Edition get it for free.
// The mobile companion is a separate app with its own notification sounds — not applicable here.

export type SfxKind = 'done' | 'needsYou'

/** One scheduled voice. `noise` is a filtered white-noise burst; everything else is an oscillator. */
export interface SfxVoice {
  kind: 'tone' | 'noise'
  /** Seconds from the start of the effect. */
  at: number
  /** Seconds. */
  dur: number
  /** Start frequency (Hz). For `noise`, the band-pass center. */
  freq: number
  /** Optional end frequency — the voice sweeps freq → freqTo over `dur`. */
  freqTo?: number
  /** Peak gain, relative to the master volume (0..1). */
  gain: number
  wave?: OscillatorType
}

/**
 * The score for an effect. PURE — no WebAudio, so the shape of each effect is unit-testable and
 * tweaking a sound never means booting a renderer.
 */
export function sfxScore(kind: SfxKind): SfxVoice[] {
  if (kind === 'done') {
    // Four square blips climbing a major-ish arpeggio, the last one bent upward — bright, brief,
    // unmistakably "finished".
    const notes = [784, 988, 1319, 1568]
    return notes.map((freq, i) => ({
      kind: 'tone' as const,
      at: i * 0.045,
      dur: i === notes.length - 1 ? 0.11 : 0.06,
      freq,
      ...(i === notes.length - 1 ? { freqTo: 1976 } : {}),
      gain: 0.55,
      wave: 'square' as const
    }))
  }
  // "Needs you": two crackle-and-drop pairs — a band-passed noise burst (the computer crackle)
  // over a saw tone falling in pitch, which reads as a question/alert rather than a success.
  return [
    { kind: 'noise', at: 0, dur: 0.05, freq: 1400, gain: 0.35 },
    { kind: 'tone', at: 0.01, dur: 0.1, freq: 320, freqTo: 180, gain: 0.5, wave: 'sawtooth' },
    { kind: 'noise', at: 0.14, dur: 0.05, freq: 1100, gain: 0.3 },
    { kind: 'tone', at: 0.15, dur: 0.12, freq: 300, freqTo: 150, gain: 0.45, wave: 'sawtooth' }
  ]
}

/** Master trim on top of the user's volume — these are notification chirps, not music. */
const MASTER = 0.22

let ctx: AudioContext | null = null
let noiseBuf: AudioBuffer | null = null

function audio(): AudioContext | null {
  if (ctx) return ctx
  const Ctor: typeof AudioContext | undefined =
    typeof window === 'undefined'
      ? undefined
      : window.AudioContext ||
        (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
  if (!Ctor) return null
  try {
    ctx = new Ctor()
  } catch {
    return null
  }
  return ctx
}

/**
 * Resume the audio context. Browsers (Server Edition) start it `suspended` until a user gesture;
 * Electron does not care. Safe to call repeatedly — it's a no-op once running.
 */
export function primeSfx(): void {
  const c = audio()
  if (c && c.state === 'suspended') void c.resume()
}

function noise(c: AudioContext): AudioBuffer {
  if (noiseBuf) return noiseBuf
  const len = Math.floor(c.sampleRate * 0.25)
  const buf = c.createBuffer(1, len, c.sampleRate)
  const data = buf.getChannelData(0)
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1
  noiseBuf = buf
  return buf
}

/**
 * Play an effect. Never throws and never blocks: an unavailable/blocked audio context is simply
 * silence — a sound effect must not be able to break the agent-status path that calls it.
 */
export function playSfx(kind: SfxKind, volume = 0.5): void {
  const c = audio()
  if (!c) return
  if (c.state === 'suspended') void c.resume()
  const vol = Math.max(0, Math.min(1, volume)) * MASTER
  if (vol <= 0) return
  const t0 = c.currentTime + 0.01
  try {
    for (const v of sfxScore(kind)) {
      const g = c.createGain()
      const peak = vol * v.gain
      // Fast attack, exponential-ish decay to silence — a linear release rings like a click.
      g.gain.setValueAtTime(0, t0 + v.at)
      g.gain.linearRampToValueAtTime(peak, t0 + v.at + 0.005)
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + v.at + v.dur)
      g.connect(c.destination)

      if (v.kind === 'noise') {
        const src = c.createBufferSource()
        src.buffer = noise(c)
        const bp = c.createBiquadFilter()
        bp.type = 'bandpass'
        bp.frequency.value = v.freq
        bp.Q.value = 1.2
        src.connect(bp).connect(g)
        src.start(t0 + v.at)
        src.stop(t0 + v.at + v.dur)
      } else {
        const osc = c.createOscillator()
        osc.type = v.wave ?? 'square'
        osc.frequency.setValueAtTime(v.freq, t0 + v.at)
        if (v.freqTo) osc.frequency.exponentialRampToValueAtTime(v.freqTo, t0 + v.at + v.dur)
        osc.connect(g)
        osc.start(t0 + v.at)
        osc.stop(t0 + v.at + v.dur)
      }
    }
  } catch {
    // Nothing to do — losing a chirp is never worth surfacing.
  }
}
