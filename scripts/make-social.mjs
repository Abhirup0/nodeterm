// Generates social-media images into docs/assets/social/. Run: npm run make-social
//   og.png      1200x630  — link preview / Open Graph + Twitter card
//   avatar.png  1024x1024 — square profile picture (safe for circle crops)
//   banner.png  1500x500  — X/Twitter header
import { mkdirSync, writeFileSync } from 'fs'
import sharp from 'sharp'

// The app icon (black terminal window + our purple mark), in 1024 user-space, as a
// reusable group placed at (x,y) scaled into a `size`×`size` box.
function iconGroup(x, y, size) {
  const s = size / 1024
  return `<g transform="translate(${x} ${y}) scale(${s})">
    <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#tile)"/>
    <rect x="101" y="101" width="822" height="822" rx="184" fill="none" stroke="#ffffff" stroke-opacity="0.07" stroke-width="2"/>
    <g fill="#50505a">
      <circle cx="186" cy="190" r="15"/><circle cx="232" cy="190" r="15"/><circle cx="278" cy="190" r="15"/>
    </g>
    <g transform="translate(512 528) scale(12) translate(-26.5 -24)" stroke-linecap="round" stroke-linejoin="round">
      <path d="M13 12 L31 24 L13 36" fill="none" stroke="url(#mark)" stroke-width="5"/>
      <circle cx="13" cy="12" r="3.6" fill="#a38dff"/>
      <circle cx="13" cy="36" r="3.6" fill="#a38dff"/>
      <circle cx="31" cy="24" r="3.6" fill="#ffffff"/>
      <rect x="33.5" y="32.5" width="10.5" height="5" rx="2.5" fill="#a38dff"/>
    </g>
  </g>`
}

const DEFS = `<defs>
  <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#2a2a30"/><stop offset="1" stop-color="#0b0b0e"/>
  </linearGradient>
  <linearGradient id="mark" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#a38dff"/><stop offset="1" stop-color="#7a4bd0"/>
  </linearGradient>
  <linearGradient id="word" x1="0" y1="0" x2="1" y2="1">
    <stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#cbb8ff"/>
  </linearGradient>
  <radialGradient id="glow" cx="50%" cy="0%" r="75%">
    <stop offset="0" stop-color="#6a4bd0" stop-opacity="0.20"/>
    <stop offset="1" stop-color="#6a4bd0" stop-opacity="0"/>
  </radialGradient>
  <pattern id="grid" width="44" height="44" patternUnits="userSpaceOnUse">
    <path d="M44 0 H0 V44" fill="none" stroke="#ffffff" stroke-opacity="0.04" stroke-width="1"/>
  </pattern>
</defs>`

const FONT = 'Helvetica Neue, Helvetica, Arial, sans-serif'

function bg(w, h) {
  return `<rect width="${w}" height="${h}" fill="#0a0a0a"/>
  <rect width="${w}" height="${h}" fill="url(#grid)"/>
  <rect width="${w}" height="${h}" fill="url(#glow)"/>`
}

const assets = {
  // Horizontal link-preview card: icon left, wordmark + tagline right.
  'og.png': { w: 1200, h: 630, svg: (w, h) => `
    ${bg(w, h)}
    ${iconGroup(96, 175, 280)}
    <text x="430" y="300" font-family="${FONT}" font-size="92" font-weight="800" fill="url(#word)" letter-spacing="-3">nodeterm</text>
    <text x="434" y="360" font-family="${FONT}" font-size="33" fill="#9a9aa2">Your terminals on an infinite canvas.</text>
    <text x="434" y="408" font-family="${FONT}" font-size="24" fill="#6a6a72">node-based terminal manager · macOS · free</text>` },

  // Square avatar — icon centered with margin so circle crops stay clean.
  'avatar.png': { w: 1024, h: 1024, svg: (w, h) => `
    <rect width="${w}" height="${h}" fill="#0a0a0a"/>
    <rect width="${w}" height="${h}" fill="url(#glow)"/>
    ${iconGroup(112, 112, 800)}` },

  // X/Twitter header banner.
  'banner.png': { w: 1500, h: 500, svg: (w, h) => `
    ${bg(w, h)}
    ${iconGroup(150, 100, 300)}
    <text x="520" y="235" font-family="${FONT}" font-size="104" font-weight="800" fill="url(#word)" letter-spacing="-4">nodeterm</text>
    <text x="524" y="300" font-family="${FONT}" font-size="38" fill="#9a9aa2">Your terminals on an infinite canvas.</text>` }
}

const outDir = 'docs/assets/social'
mkdirSync(outDir, { recursive: true })

for (const [name, a] of Object.entries(assets)) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${a.w}" height="${a.h}" viewBox="0 0 ${a.w} ${a.h}">${DEFS}${a.svg(a.w, a.h)}</svg>`
  const png = await sharp(Buffer.from(svg)).png().toBuffer()
  writeFileSync(`${outDir}/${name}`, png)
  console.log(`wrote ${outDir}/${name} (${a.w}x${a.h})`)
}
