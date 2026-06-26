/**
 * A small, self-contained T-Rex–style endless runner rendered to a <canvas>.
 *
 * Written from scratch (no vendored engine, no sprite/sound assets) so it fits
 * the app cleanly: dark theme, and input + sound are scoped to the node — the
 * game only listens for keys while its host element is focused and pauses
 * (silently) when focus leaves, so it never bleeds into other nodes. The public
 * interface matches what DinoNode expects; high score is seeded in and reported
 * back out for persistence.
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

  // T-Rex drawn as pixel art (self-contained — no sprite asset). '#' = filled,
  // '.' = transparent; the eye is a transparent hole so the background shows
  // through. Rendered at 2px/cell and tinted to the theme. The body is shared;
  // the legs swap each step to animate the run.
  const PX = 2
  const DINO_BODY = [
    '............######..',
    '............######..',
    '............######..',
    '............#.####..',
    '............######..',
    '............#######.',
    '#...........#######.',
    '##..........#######.',
    '###........########.',
    '####......#########.',
    '######...##########.',
    '###################.',
    '####################',
    '####################',
    '.##################.',
    '..################..',
    '...##############...'
  ]
  const DINO_LEGS_A = [
    '...####....#####....',
    '...###......####....',
    '...###.......##.....',
    '...##........##.....',
    '..###........###....'
  ]
  const DINO_LEGS_B = [
    '...####....#####....',
    '...####.....###.....',
    '....##......####....',
    '....##.......##.....',
    '...###.......###....'
  ]
  const DINO_DUCK_A = [
    '..................######',
    '..................######',
    '..................#.####',
    '..................######',
    '##................######',
    '###..............#######',
    '########################',
    '########################',
    '.######################.',
    '..####...####....#####..',
    '..###.....##.....####...',
    '..##......##.....###....',
    '..##......##.....###....'
  ]
  const DINO_DUCK_B = [
    '..................######',
    '..................######',
    '..................#.####',
    '..................######',
    '##................######',
    '###..............#######',
    '########################',
    '########################',
    '.######################.',
    '..####...####....#####..',
    '...###....##......###...',
    '...##.....##......##....',
    '...##.....##......##....'
  ]

  function drawBitmap(rows: string[], ox: number, oy: number, color: string) {
    ctx.fillStyle = color
    for (let r = 0; r < rows.length; r++) {
      const row = rows[r]
      for (let c = 0; c < row.length; c++) {
        if (row[c] === '#') ctx.fillRect(ox + c * PX, oy + r * PX, PX, PX)
      }
    }
  }

  // Logical play-field size in CSS pixels; recomputed from the host on resize.
  let W = 600
  let H = 200
  let groundY = 0

  function layout() {
    const rect = host.getBoundingClientRect()
    W = Math.max(240, Math.round(rect.width))
    H = Math.max(120, Math.round(rect.height))
    groundY = H - 28
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.round(W * dpr)
    canvas.height = Math.round(H * dpr)
    canvas.style.width = W + 'px'
    canvas.style.height = H + 'px'
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  }

  // --- Game state -----------------------------------------------------------
  const GRAVITY = 2400 // px/s^2
  const JUMP_V = -780 // px/s
  const DINO_X = 56
  const DINO_W = 40
  const DINO_H = 44
  const DUCK_H = 26

  let best = Math.max(0, Math.round(opts.initialHighScore) || 0)
  let score = 0
  let speed = 320 // px/s, ramps up
  let dinoY = 0 // offset above ground (0 = on ground)
  let dinoV = 0
  let ducking = false
  let crashed = false
  let started = false
  let focused = false
  let nextSpawn = 0
  let groundScroll = 0

  interface Obstacle {
    x: number
    w: number
    h: number
    y: number // top offset above ground
    bird: boolean
    flap: number
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
    // Mostly ground cacti; occasional flying bird at duck height.
    const bird = Math.random() < 0.22 && score > 120
    if (bird) {
      const y = 30 + Math.round(Math.random() * 26) // hover above ground
      obstacles.push({ x: W + 20, w: 34, h: 24, y, bird: true, flap: 0 })
    } else {
      const big = Math.random() < 0.5
      const w = big ? 26 : 16
      const h = big ? 46 : 34
      obstacles.push({ x: W + 20, w, h, y: 0, bird: false, flap: 0 })
    }
    // Gap shrinks slightly as it speeds up.
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

  // --- Update + draw --------------------------------------------------------
  function update(dt: number) {
    if (crashed || !started) return
    score += dt * 22
    speed += dt * 14
    groundScroll = (groundScroll + speed * dt) % 24

    // dino physics
    if (dinoY < 0 || dinoV !== 0) {
      dinoV += GRAVITY * dt
      dinoY += dinoV * dt
      if (dinoY >= 0) {
        dinoY = 0
        dinoV = 0
      }
    }

    // obstacles
    nextSpawn -= dt
    if (nextSpawn <= 0) spawn()
    const dh = ducking && dinoY === 0 ? DUCK_H : DINO_H
    const dinoRect = { x: DINO_X, y: groundY - dh + dinoY, w: DINO_W, h: dh }
    for (const o of obstacles) {
      o.x -= speed * dt
      if (o.bird) o.flap += dt * 10
      const oy = groundY - o.h - o.y
      if (
        dinoRect.x < o.x + o.w &&
        dinoRect.x + dinoRect.w > o.x &&
        dinoRect.y < oy + o.h &&
        dinoRect.y + dinoRect.h > oy
      ) {
        crashed = true
        if (Math.round(score) > best) {
          best = Math.round(score)
          opts.onHighScore(best)
        }
        blip(140, 0.25, 'sawtooth')
      }
    }
    obstacles = obstacles.filter((o) => o.x + o.w > -10)
  }

  function drawDino() {
    const color = crashed ? COLOR_DIM : COLOR_FG
    const onGround = dinoY === 0
    let rows: string[]
    if (ducking && onGround && !crashed) {
      rows = Math.floor(score * 0.6) % 2 === 0 ? DINO_DUCK_A : DINO_DUCK_B
    } else {
      // Animate legs only while actually running on the ground.
      const legs =
        started && onGround && !crashed
          ? Math.floor(score * 0.5) % 2 === 0
            ? DINO_LEGS_A
            : DINO_LEGS_B
          : DINO_LEGS_A
      rows = DINO_BODY.concat(legs)
    }
    const oy = groundY - rows.length * PX + dinoY
    drawBitmap(rows, DINO_X, oy, color)
  }

  function drawObstacle(o: Obstacle) {
    const oy = groundY - o.h - o.y
    ctx.fillStyle = COLOR_FG
    if (o.bird) {
      const up = Math.floor(o.flap) % 2 === 0
      ctx.fillRect(o.x, oy + (up ? 0 : 8), o.w, 6)
      ctx.fillRect(o.x + o.w / 2 - 3, oy + 6, 6, o.h - 6)
    } else {
      ctx.fillRect(o.x, oy, o.w, o.h)
      ctx.fillRect(o.x - 5, oy + o.h * 0.35, 5, 4)
      ctx.fillRect(o.x + o.w, oy + o.h * 0.5, 5, 4)
    }
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
