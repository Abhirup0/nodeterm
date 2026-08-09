import type { CSSProperties } from 'react'
import type { AgentId } from '@shared/agents/config'
import { CLAUDE_MASCOT, CODEX_MASCOT } from '../lib/mascot'
import { GrokMark } from '../lib/agentIcons'
import codexPet from '../assets/pet-codex.webp'

/** Grok's badge glyph height, matched to CLAUDE_FRAME_HEIGHT so the two sit on one baseline. */
const GROK_BADGE_SIZE = 16

/**
 * The walking mascot shown inside the RUNNING badge (docs/mascot-sprites.md):
 * - claude → the runtime-drawn coral pixel critter (data-URI spritesheet; the walk is CSS
 *   `steps(1)` over three keyframes, NOT `steps(2)` — see .term-node__mascot--claude).
 * - grok   → its own BRAND MARK, pulsing and blooming rather than walking. It had a quadrant
 *   critter first; a hand-drawn creature next to two real mascots read as neither, so the glyph
 *   grok actually has is what animates. `currentColor` + a `drop-shadow` bloom keeps that legible
 *   in both themes without picking an ink (see .term-node__mascot--grok).
 * - codex  → pet-codex.webp, first-row walk cycle (CSS `steps(8)`).
 * - anything else (gemini/opencode/custom/plain) → the plain pulsing dot, unchanged.
 *
 * Animation is pure CSS (see .term-node__mascot* in styles.css) — no JS timers, so a canvas
 * full of RUNNING terminals costs nothing per node. Dimensions come from lib/mascot.ts so the
 * CSS scaling and the geometry can never desync.
 */
export function AgentMascot({ agentId }: { agentId?: AgentId }): React.JSX.Element {
  if (agentId === 'claude' && CLAUDE_MASCOT.src) {
    const style = {
      '--mascot-w': `${CLAUDE_MASCOT.frameWidth}px`,
      '--mascot-h': `${CLAUDE_MASCOT.frameHeight}px`,
      backgroundImage: `url(${CLAUDE_MASCOT.src})`
    } as CSSProperties
    return <span className="term-node__mascot term-node__mascot--claude" style={style} aria-hidden />
  }

  if (agentId === 'grok') {
    // The badge's own glyph, not a sprite — so there is no spritesheet, no frame geometry and
    // nothing that can desync from lib/mascot.ts. Sized to sit level with claude's 16px-tall critter.
    return <GrokMark size={GROK_BADGE_SIZE} className="term-node__mascot--grok" />
  }

  if (agentId === 'codex') {
    const style = {
      '--cmascot-w': `${CODEX_MASCOT.frameWidth}px`,
      '--cmascot-h': `${CODEX_MASCOT.frameHeight}px`,
      '--cmascot-sheet-w': `${CODEX_MASCOT.frameWidth * CODEX_MASCOT.cols}px`,
      '--cmascot-sheet-h': `${CODEX_MASCOT.frameHeight * CODEX_MASCOT.rows}px`,
      backgroundImage: `url(${codexPet})`
    } as CSSProperties
    return <span className="term-node__mascot term-node__mascot--codex" style={style} aria-hidden />
  }

  // Every other agent keeps the original pulsing dot.
  return <span className="term-node__status-dot" />
}
