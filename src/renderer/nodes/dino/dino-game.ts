import spriteUrl from './sprite-1x.png'

/**
 * A small, self-contained T-Rex–style endless runner rendered to a <canvas>.
 *
 * Game logic is written from scratch (no vendored engine, no global listeners)
 * so it fits the app: dark theme, and input + sound are scoped to the node — it
 * only listens for keys while its host element is focused and pauses (silently)
 * on blur, so it never bleeds into other nodes. The artwork is the authentic
 * Chrome offline sprite sheet (`sprite-1x.png`), drawn frame-by-frame from its
 * real atlas coordinates and tinted light so it reads on the dark field. The
 * public interface matches DinoNode; high score is seeded in and reported out.
 */
export function createDinoGame(
  host: HTMLElement,
  opts: { initialHighScore: number; onHighScore: (score: number) => void }
): { destroy: () => void } {
  const canvas = document.createElement('canvas')
  canvas.className = 'dino-canvas'
  host.appendChild(canvas)
  const ctx = canvas.getContext('2d')!

  // Palette (dark theme — light marks on a near-black field).
  const COLOR_FG = '#e6e6ea'
  const COLOR_DIM = '#6b6b73'
  const COLOR_BG = '#0b0b0f'

  // --- Sprite sheet (authentic Chrome offline atlas, 1x). All frames sit on
  // row y=2. The sheet is dark grey on transparent; we recolor it to the theme
  // foreground once into an offscreen canvas (source-in keeps the alpha).
  const SY = 2
  const TREX = {
    IDLE: 848,
    RUN: [936, 980],
    CRASH: 1068,
    DUCK: [1112, 1171],
    W: 44,
    DW: 59,
    H: 47
  }
  // Obstacle frames: [sx, spriteW, spriteH] + a forgiving collision inset.
  const CACTUS_SMALL = { sx: 228, w: 17, h: 35, col: { x: 2, y: 5, w: 13, h: 28 } }
  const CACTUS_LARGE = { sx: 332, w: 25, h: 50, col: { x: 4, y: 6, w: 17, h: 42 } }
  const BIRD = { sx: [134, 180], w: 46, h: 40, col: { x: 6, y: 8, w: 34, h: 22 } }

  // RGB of the theme colors, used to recolor the sprite per pixel.
  const fg = [0xe6, 0xe6, 0xea]
  const bg = [0x0b, 0x0b, 0x0f]

  let tinted: HTMLCanvasElement | null = null
  const img = new Image()
  img.onload = () => {
    const off = document.createElement('canvas')
    off.width = img.naturalWidth
    off.height = img.naturalHeight
    const octx = off.getContext('2d')!
    octx.drawImage(img, 0, 0)
    // The sprite is a dark-grey dino on transparent, with WHITE details (eye,
    // open mouth). Recolor per pixel so the body reads light on the dark field
    // while the white details become dark "holes" — preserving the eye/mouth
    // for free, instead of flattening everything to one tint.
    const id = octx.getImageData(0, 0, off.width, off.height)
    const p = id.data
    for (let i = 0; i < p.length; i += 4) {
      if (p[i + 3] < 40) continue // transparent → leave as is
      const lum = (p[i] + p[i + 1] + p[i + 2]) / 3
      const c = lum > 150 ? bg : fg // white detail → dark hole; grey body → light
      p[i] = c[0]
      p[i + 1] = c[1]
      p[i + 2] = c[2]
      p[i + 3] = 255
    }
    octx.putImageData(id, 0, 0)
    tinted = off
    draw() // sprite arrived — refresh the current (possibly idle) frame
  }
  img.src = spriteUrl

  function blit(sx: number, sw: number, sh: number, dx: number, dy: number, alpha = 1) {
    if (!tinted) return
    if (alpha !== 1) ctx.globalAlpha = alpha
    ctx.drawImage(tinted, sx, SY, sw, sh, Math.round(dx), Math.round(dy), sw, sh)
    if (alpha !== 1) ctx.globalAlpha = 1
  }

  // --- Layout (canvas tracks the host size; logical units = CSS px) ---------
  let W = 600
  let H = 200
  let groundY = 0
  function layout() {
    const rect = host.getBoundingClientRect()
    W = Math.max(240, Math.round(rect.width))
    H = Math.max(120, Math.round(rect.height))
    groundY = H - 26
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    canvas.style.width = W + 'px'
    canvas.style.height = H + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.imageSmoothingEnabled = false
  }

  // --- Game state -----------------------------------------------------------
  const GRAVITY = 2400 // px/s^2
  const JUMP_V = -820 // px/s
  const DINO_X = 24

  let best = Math.max(0, Math.round(opts.initialHighScore) || 0)
  let score = 0
  let speed = 320 // px/s, ramps up
  let dinoY = 0 // <= 0, offset above ground
  let dinoV = 0
  let ducking = false
  let crashed = false
  let started = false
  let focused = false
  let nextSpawn = 0
  let groundScroll = 0

  interface Obstacle {
    kind: 'cactus' | 'bird'
    x: number
    y: number // height above ground (0 for cacti)
    sx: number
    sw: number
    sh: number
    flap: number
    col: { x: number; y: number; w: number; h: number }
  }
  let obstacles: Obstacle[] = []

  function reset() {
    score = 0
    speed = 320
    dinoY = 0
    dinoV = 0
    ducking = false
    crashed = false
    obstacles = []
    nextSpawn = 0
  }

  function spawn() {
    const bird = Math.random() < 0.2 && score > 150
    if (bird) {
      const y = Math.random() < 0.5 ? 4 : 34 // low → jump, high → duck
      obstacles.push({ kind: 'bird', x: W + 20, y, sx: BIRD.sx[0], sw: BIRD.w, sh: BIRD.h, flap: 0, col: BIRD.col })
    } else {
      const c = Math.random() < 0.45 ? CACTUS_LARGE : CACTUS_SMALL
      obstacles.push({ kind: 'cactus', x: W + 20, y: 0, sx: c.sx, sw: c.w, sh: c.h, flap: 0, col: c.col })
    }
    nextSpawn = 0.9 + Math.random() * 0.8 - Math.min(0.35, speed / 4000)
  }

  // --- Sound (lazy WebAudio; only while focused, so it can't bleed) ---------
  let audio: AudioContext | null = null
  function blip(freq: number, dur: number, type: OscillatorType = 'square') {
    if (!focused) return
    try {
      if (!audio) audio = new AudioContext()
      const t = audio.currentTime
      const osc = audio.createOscillator()
      const gain = audio.createGain()
      osc.type = type
      osc.frequency.value = freq
      gain.gain.setValueAtTime(0.04, t)
      gain.gain.exponentialRampToValueAtTime(0.0001, t + dur)
      osc.connect(gain).connect(audio.destination)
      osc.start(t)
      osc.stop(t + dur)
    } catch {
      /* audio unavailable — ignore */
    }
  }

  function jump() {
    if (crashed) {
      reset()
      started = true
      blip(440, 0.08)
      return
    }
    started = true
    if (dinoY === 0) {
      dinoV = JUMP_V
      blip(660, 0.08)
    }
  }

  // Dino collision box (forgiving inset around the visible body).
  function dinoBox() {
    if (ducking && dinoY === 0) return { x: DINO_X + 10, y: groundY - 24, w: 44, h: 22 }
    return { x: DINO_X + 12, y: groundY - 40 + dinoY, w: 20, h: 38 }
  }

  // --- Update + draw --------------------------------------------------------
  function update(dt: number) {
    if (crashed || !started) return
    score += dt * 22
    speed += dt * 14
    groundScroll = (groundScroll + speed * dt) % 24

    if (dinoY < 0 || dinoV !== 0) {
      dinoV += GRAVITY * dt
      dinoY += dinoV * dt
      if (dinoY >= 0) {
        dinoY = 0
        dinoV = 0
      }
    }

    nextSpawn -= dt
    if (nextSpawn <= 0) spawn()

    const d = dinoBox()
    for (const o of obstacles) {
      o.x -= speed * dt
      if (o.kind === 'bird') o.flap += dt * 9
      const oy = groundY - o.sh - o.y
      const ox = o.x + o.col.x
      const oyc = oy + o.col.y
      if (d.x < ox + o.col.w && d.x + d.w > ox && d.y < oyc + o.col.h && d.y + d.h > oyc) {
        crashed = true
        if (Math.round(score) > best) {
          best = Math.round(score)
          opts.onHighScore(best)
        }
        blip(140, 0.25, 'sawtooth')
      }
    }
    obstacles = obstacles.filter((o) => o.x + o.sw > -10)
  }

  function drawDino() {
    const onGround = dinoY === 0
    let sx: number
    let sw = TREX.W
    if (crashed) sx = TREX.CRASH
    else if (ducking && onGround) {
      sx = Math.floor(score * 0.25) % 2 === 0 ? TREX.DUCK[0] : TREX.DUCK[1]
      sw = TREX.DW
    } else if (!onGround) sx = TREX.IDLE
    else if (started) sx = Math.floor(score * 0.4) % 2 === 0 ? TREX.RUN[0] : TREX.RUN[1]
    else sx = TREX.IDLE
    blit(sx, sw, TREX.H, DINO_X, groundY - TREX.H + dinoY, crashed ? 0.55 : 1)
  }

  function drawObstacle(o: Obstacle) {
    const oy = groundY - o.sh - o.y
    const sx = o.kind === 'bird' ? (Math.floor(o.flap) % 2 === 0 ? BIRD.sx[0] : BIRD.sx[1]) : o.sx
    blit(sx, o.sw, o.sh, o.x, oy)
  }

  function draw() {
    ctx.fillStyle = COLOR_BG
    ctx.fillRect(0, 0, W, H)

    // ground line with moving dashes
    ctx.fillStyle = COLOR_DIM
    ctx.fillRect(0, groundY, W, 2)
    ctx.fillStyle = COLOR_FG
    for (let x = -groundScroll; x < W; x += 24) ctx.fillRect(x, groundY + 5, 10, 2)

    obstacles.forEach(drawObstacle)
    drawDino()

    // score / high score
    ctx.fillStyle = COLOR_DIM
    ctx.font = '12px ui-monospace, Menlo, monospace'
    ctx.textAlign = 'right'
    const hi = best > 0 ? `HI ${String(best).padStart(5, '0')}  ` : ''
    ctx.fillText(`${hi}${String(Math.round(score)).padStart(5, '0')}`, W - 10, 18)
    ctx.textAlign = 'left'

    if (!started && !crashed) {
      ctx.fillStyle = COLOR_DIM
      ctx.font = '13px ui-sans-serif, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText(focused ? 'Press Space to start' : 'Click, then Space to play', W / 2, H / 2 - 6)
      ctx.textAlign = 'left'
    }
    if (crashed) {
      ctx.fillStyle = COLOR_FG
      ctx.font = 'bold 14px ui-sans-serif, system-ui, sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('G A M E   O V E R', W / 2, H / 2 - 6)
      ctx.font = '12px ui-sans-serif, system-ui, sans-serif'
      ctx.fillStyle = COLOR_DIM
      ctx.fillText('Space to retry', W / 2, H / 2 + 14)
      ctx.textAlign = 'left'
    }
  }

  // --- Loop (runs only while focused) ---------------------------------------
  let raf = 0
  let last = 0
  function frame(now: number) {
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0
    last = now
    update(dt)
    draw()
    raf = requestAnimationFrame(frame)
  }
  function start() {
    if (raf) return
    last = 0
    raf = requestAnimationFrame(frame)
  }
  function stop() {
    if (raf) cancelAnimationFrame(raf)
    raf = 0
  }

  // --- Input (scoped to host focus) -----------------------------------------
  const onKey = (e: KeyboardEvent) => {
    if (e.key === ' ' || e.key === 'ArrowUp' || e.key === 'Spacebar') {
      e.preventDefault()
      e.stopPropagation()
      jump()
    } else if (e.key === 'ArrowDown') {
      e.preventDefault()
      e.stopPropagation()
      ducking = true
    }
  }
  const onKeyUp = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') ducking = false
  }
  const onFocus = () => {
    focused = true
    start()
  }
  const onBlur = () => {
    focused = false
    ducking = false
    stop()
    draw() // leave a static idle frame
  }
  const onPointerDown = () => host.focus()

  host.addEventListener('keydown', onKey)
  host.addEventListener('keyup', onKeyUp)
  host.addEventListener('focus', onFocus)
  host.addEventListener('blur', onBlur)
  host.addEventListener('pointerdown', onPointerDown)
  const ro = new ResizeObserver(() => {
    layout()
    draw()
  })
  ro.observe(host)

  layout()
  draw() // initial idle frame

  return {
    destroy() {
      stop()
      ro.disconnect()
      host.removeEventListener('keydown', onKey)
      host.removeEventListener('keyup', onKeyUp)
      host.removeEventListener('focus', onFocus)
      host.removeEventListener('blur', onBlur)
      host.removeEventListener('pointerdown', onPointerDown)
      if (audio) {
        void audio.close()
        audio = null
      }
      canvas.remove()
    }
  }
}
