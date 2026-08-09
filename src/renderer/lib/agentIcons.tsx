import type { AgentId } from '@shared/agents/config'
import claudeIcon from '../assets/claude.svg'
import codexIcon from '../assets/codex-color.svg'
import geminiIcon from '../assets/gemini-color.svg'
import opencodeIcon from '../assets/opencode.svg'
import { IconTerminal } from '../components/icons'
import { GROK_MARK_PATH, GROK_MARK_VIEWBOX } from './grokMark'

// Brand logo per builtin agent; custom/unknown agents fall back to the terminal glyph.
//
// These four are MULTI-COLOUR marks, so each carries its own fills and is loaded as an `<img src>`
// (Vite hands us a URL). An SVG loaded that way is an isolated document — `currentColor` has nothing
// to inherit there, which is why none of these assets uses it. Grok is the exception and is handled
// below: its mark is monochrome, so it is inlined instead.
const AGENT_LOGO: Partial<Record<string, string>> = {
  claude: claudeIcon,
  codex: codexIcon,
  gemini: geminiIcon,
  opencode: opencodeIcon
}

/**
 * The official Grok mark (xAI), inlined rather than shipped as an asset — geometry from
 * `lib/grokMark.ts`, which the notch HUD's imperative renderer shares.
 *
 * `className` is how the RUNNING badge reuses this exact glyph as its "working" indicator (it
 * pulses and blooms instead of walking — grok has no critter; see AgentMascot).
 */
export function GrokMark({
  size,
  className
}: {
  size: number
  className?: string
}): React.JSX.Element {
  return (
    <svg
      width={size}
      height={size}
      viewBox={GROK_MARK_VIEWBOX}
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden
      className={className}
      style={{ display: 'block' }}
    >
      <path fillRule="evenodd" clipRule="evenodd" d={GROK_MARK_PATH} />
    </svg>
  )
}

export function AgentIcon({ agentId, size = 16 }: { agentId: AgentId; size?: number }): React.JSX.Element {
  if (agentId === 'grok') return <GrokMark size={size} />
  const src = AGENT_LOGO[agentId]
  if (src) {
    return <img src={src} width={size} height={size} alt="" style={{ display: 'block' }} />
  }
  return <IconTerminal />
}
