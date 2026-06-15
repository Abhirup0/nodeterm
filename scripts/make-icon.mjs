// Renders the nodeterm mark into build/icon.png (1024x1024) for electron-builder,
// which derives the macOS .icns from it. Run: npm run make-icon
import { mkdirSync, writeFileSync } from 'fs'
import sharp from 'sharp'

// macOS app icons leave a transparent margin around a rounded-square tile so they
// sit at the same visual size as system icons in the Dock. Apple's grid puts the
// tile at ~824px inside the 1024 canvas (≈100px margin) with a ~185px corner radius.
const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#a38dff"/>
      <stop offset="1" stop-color="#622994"/>
    </linearGradient>
  </defs>
  <rect x="100" y="100" width="824" height="824" rx="185" fill="url(#g)"/>
  <g transform="translate(512 512) scale(10.5) translate(-26.5 -24)"
     fill="none" stroke="#fff" stroke-width="5" stroke-linecap="round" stroke-linejoin="round">
    <path d="M13 12 L31 24 L13 36"/>
    <circle cx="13" cy="12" r="3.6" fill="#fff" stroke="none"/>
    <circle cx="13" cy="36" r="3.6" fill="#fff" stroke="none"/>
    <circle cx="31" cy="24" r="3.6" fill="#fff" stroke="none"/>
    <rect x="33.5" y="32.5" width="10.5" height="5" rx="2.5" fill="#fff" stroke="none"/>
  </g>
</svg>`

mkdirSync('build', { recursive: true })
const png = await sharp(Buffer.from(svg)).png().toBuffer()
writeFileSync('build/icon.png', png)
console.log('wrote build/icon.png (1024x1024)')
