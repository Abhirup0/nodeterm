import { useEffect, useRef } from 'react'
import { NodeResizer, useReactFlow, type NodeProps } from '@xyflow/react'
import { type CanvasNode } from '../state/workspace'
import { createDinoGame } from './dino/dino-game'

const GAME_KEYS = new Set([' ', 'ArrowUp', 'ArrowDown', 'Spacebar'])

/**
 * A dino node: Chromium's offline T-Rex Runner on a canvas. No PTY. The game is
 * created once on mount and destroyed on unmount (React Flow keys nodes by id, so
 * the instance survives re-renders). High score persists via data.highScore — we
 * seed the engine with it and store new records back silently; the player sees the
 * authentic on-canvas "HI" rather than a header chip (the engine's raw highestScore
 * doesn't match the canvas digits, which apply a coefficient).
 */
export function DinoNode({ id, data, selected }: NodeProps<CanvasNode>) {
  const { updateNodeData, deleteElements } = useReactFlow()
  const hostRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const game = createDinoGame(host, {
      initialHighScore: data.highScore ?? 0,
      onHighScore: (score) => updateNodeData(id, { highScore: score })
    })
    return () => game.destroy()
    // Mount once; never re-run (would respawn the game). data.highScore is read
    // as the seed only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The engine listens for game keys at the document level, so we must NOT
  // stopPropagation (React's root listener sits below document — that would
  // starve the engine). preventDefault only stops the page from scrolling on
  // Space/arrows; the event still bubbles to document and the engine handles it.
  const onKeyDown = (e: React.KeyboardEvent) => {
    if (GAME_KEYS.has(e.key)) e.preventDefault()
  }

  return (
    <div className={`dino-node${selected ? ' selected' : ''}`} style={{ borderColor: data.color }}>
      <NodeResizer minWidth={400} minHeight={160} isVisible={selected} color={data.color} />

      <div className="dino-node__header" style={{ background: `${data.color}33` }}>
        <span className="term-node__color" style={{ background: data.color }} />
        <input
          className="term-node__title nodrag"
          value={data.title}
          spellCheck={false}
          onChange={(e) => updateNodeData(id, { title: e.target.value })}
        />
        <button
          className="term-node__close"
          title="Close"
          onClick={() => deleteElements({ nodes: [{ id }] })}
        >
          ×
        </button>
      </div>

      <div ref={hostRef} className="dino-node__body nodrag nowheel" tabIndex={0} onKeyDown={onKeyDown} />
    </div>
  )
}
