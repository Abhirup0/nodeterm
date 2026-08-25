// @vitest-environment jsdom
//
// Pins the DOM half of the webview keep-alive design (lib/webviewKeepAlive.ts): across project
// switches, the merged node list must never make React DETACH or MOVE a kept webview node's
// element — an Electron `<webview>`'s guest process dies on any removeChild/insertBefore that
// touches its element ([MEASURED, Electron 42.x]: survives sibling churn and display:none;
// dies on a DOM move, reloading the page).
//
// The test renders a keyed list driven by REAL merge outputs over a switch script, instruments
// the DOM mutation methods, and asserts that once a tracked "webview" element is attached, no
// DOM operation ever targets it again while its entry lives. This is precisely React's
// lastPlacedIndex contract: kept children whose relative order is stable are left untouched.
// (The React Flow layer above renders nodes in array order, keyed by id — verified end-to-end
// against the real app; this test guards the React-level invariant the merge order guarantees.)
import { act } from 'react'
import { createRoot, type Root } from 'react-dom/client'
import { afterEach, describe, expect, it } from 'vitest'
import type { CanvasNode } from '../state/workspace'
import {
  activateInPool,
  mergeWithKeepAlive,
  retireIntoPool,
  type KeepAliveEntry
} from '../lib/webviewKeepAlive'

;(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const node = (id: string, type: string, data: Record<string, unknown> = {}): CanvasNode =>
  ({
    id,
    type,
    position: { x: 10, y: 10 },
    data: { title: id, color: '#0a84ff', group: null, ...data }
  }) as unknown as CanvasNode

const browser = (id: string): CanvasNode => node(id, 'browser', { url: `https://${id}.test/` })

/** Stand-in node renderer: one keyed div per merged node, exactly how React Flow keys its node
 *  wrappers by id. The div IS the "webview" whose DOM identity we track. */
function List({ nodes }: { nodes: CanvasNode[] }) {
  return (
    <div>
      {nodes.map((n) => (
        <div key={n.id} data-id={n.id} data-ghost={n.data.ghost ? '1' : undefined} />
      ))}
    </div>
  )
}

let root: Root | null = null
let host: HTMLElement | null = null
const restores: Array<() => void> = []

afterEach(() => {
  act(() => root?.unmount())
  host?.remove()
  root = null
  host = null
  for (const r of restores.splice(0)) r()
})

/** Record every DOM mutation whose SUBJECT is an already-attached tracked element. Attaching a
 *  parent around it, or churning siblings, is free; any call naming the element itself after its
 *  first attach is the guest-killer. */
function instrument(tracked: () => Set<Element>): string[] {
  const ops: string[] = []
  const attached = new Set<Node>()
  const wrap = <K extends 'insertBefore' | 'appendChild' | 'removeChild'>(name: K): void => {
    const original = Node.prototype[name] as (...a: never[]) => Node
    const patched = function (this: Node, ...args: never[]): Node {
      const subject = args[0] as unknown as Node
      if (subject instanceof Element && tracked().has(subject)) {
        if (attached.has(subject)) ops.push(`${name}:${(subject as Element).getAttribute('data-id')}`)
        else if (name !== 'removeChild') attached.add(subject)
      }
      return original.apply(this, args)
    }
    Object.defineProperty(Node.prototype, name, { value: patched, configurable: true, writable: true })
    restores.push(() => {
      Object.defineProperty(Node.prototype, name, { value: original, configurable: true, writable: true })
    })
  }
  wrap('insertBefore')
  wrap('appendChild')
  wrap('removeChild')
  return ops
}

describe('webview keep-alive DOM stability', () => {
  it('a webview node element is never detached or moved across project switches', () => {
    const projects: Record<string, CanvasNode[]> = {
      p1: [node('t1', 'terminal'), browser('b1'), node('s1', 'sticky'), browser('b2')],
      p2: [browser('c1'), node('t2', 'terminal')],
      p3: [node('t3', 'terminal')]
    }
    let entries: KeepAliveEntry[] = []
    let activePid = 'p1'
    let clock = 0

    host = document.createElement('div')
    document.body.append(host)
    root = createRoot(host)

    const webviewEls = (): Set<Element> =>
      new Set([...document.querySelectorAll('[data-id^="b"], [data-id^="c"]')])
    // Tracked set is resolved lazily per call — it must include elements attached at any point.
    const everTracked = new Set<Element>()
    const ops = instrument(() => {
      for (const el of webviewEls()) everTracked.add(el)
      return everTracked
    })

    const render = (): void => {
      const merged = mergeWithKeepAlive(projects[activePid], [], entries, activePid)
      act(() => root!.render(<List nodes={merged} />))
    }
    const switchTo = (pid: string): void => {
      entries = activateInPool(entries, pid)
      entries = retireIntoPool(entries, activePid, projects[activePid], ++clock)
      activePid = pid
      render()
    }

    render()
    const b1 = document.querySelector('[data-id="b1"]')
    expect(b1).toBeTruthy()

    switchTo('p2') // b1/b2 become ghosts, c1 goes live
    expect(document.querySelector('[data-id="b1"]')).toBe(b1) // same DOM element
    expect(b1!.getAttribute('data-ghost')).toBe('1')

    projects.p2 = [...projects.p2, browser('c2')] // create a browser mid-session
    render()
    switchTo('p3') // everything webview is a ghost
    switchTo('p1') // b1/b2 return to live
    expect(document.querySelector('[data-id="b1"]')).toBe(b1)
    expect(b1!.getAttribute('data-ghost')).toBeNull()
    switchTo('p2')
    switchTo('p1')

    // The invariant: not one insertBefore/appendChild/removeChild ever named an attached
    // webview element. (Deleting a node legitimately removes its element — not exercised here.)
    expect(ops).toEqual([])
  })
})
