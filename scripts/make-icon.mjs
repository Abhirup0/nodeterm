// Renders the nodeterm app icon into build/icon.png (1024x1024) for electron-builder,
// which derives the macOS .icns from it. Run: npm run make-icon
//
// Design: a black macOS-Terminal-style window (dark rounded square + window dots),
// with the nodeterm node-graph mark in our purple inside it.
import { mkdirSync, writeFileSync } from 'fs'
import sharp from 'sharp'

// macOS app icons leave a transparent margin around a rounded-square tile so they
// sit at the same visual size as system icons in the Dock. Apple's grid puts the
// tile at ~824px inside the 1024 canvas (≈100px margin) with a ~185px corner radius.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#2a2a30"/>
      <stop offset="1" stop-color="#0b0b0e"/>
    </linearGradient>
    <linearGradient id="mark" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#a38dff"/>
      <stop offset="1" stop-color="#7a4bd0"/>
    </linearGradient>
  </defs>

  <!-- black terminal window -->
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#tile)"/>
  <rect x="101" y="101" width="822" height="822" rx="184" fill="none"
        stroke="#ffffff" stroke-opacity="0.07" stroke-width="2"/>

  <!-- window dots (top-left) -->
  <g fill="#50505a">
    <circle cx="186" cy="190" r="15"/>
    <circle cx="232" cy="190" r="15"/>
    <circle cx="278" cy="190" r="15"/>
  </g>

  <!-- nodeterm mark, in our purple -->
  <g transform="translate(512 528) scale(12) translate(-26.5 -24)"
     stroke-linecap="round" stroke-linejoin="round">
    <path d="M13 12 L31 24 L13 36" fill="none" stroke="url(#mark)" stroke-width="5"/>
    <circle cx="13" cy="12" r="3.6" fill="#a38dff"/>
    <circle cx="13" cy="36" r="3.6" fill="#a38dff"/>
    <circle cx="31" cy="24" r="3.6" fill="#ffffff"/>
    <rect x="33.5" y="32.5" width="10.5" height="5" rx="2.5" fill="#a38dff"/>
  </g>
</svg>`

mkdirSync('build', { recursive: true })
const png = await sharp(Buffer.from(svg)).png().toBuffer()
writeFileSync('build/icon.png', png)
console.log('wrote build/icon.png (1024x1024)')
