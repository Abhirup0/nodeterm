/**
 * `@ref` bookkeeping for `--read map` / `--read text`. A ref (`@7`) is a HANDLE the agent later spends
 * on a click or a describe, and its whole safety rests on two scopes:
 *   1. it belongs to ONE node — a ref minted on browser-1 never resolves on browser-2;
 *   2. it belongs to ONE navigation generation — the moment the page navigates, every ref from the
 *      previous map is dead.
 *
 * A stale ref is a REFUSAL, never a best-effort re-resolution. A ref that silently re-resolves after a
 * navigation is how an agent clicks "Delete account" while meaning "Next page" — so this is a
 * correctness property before it is a security one. The generation is bumped by BOTH Page.frameNavigated
 * and Runtime.executionContextsCleared (PR 7 wires those events to {@link RefTable.bumpGeneration});
 * both funnel through the one invalidation path so neither can be forgotten independently.
 *
 * Main-side (its inputs come from CDP), never Server Edition.
 */

export type RefItem = Record<string, unknown>

export interface MintResult {
  /** The generation these refs are stamped with (echoes the `gen` passed in). */
  gen: number
  /** `['@1', '@2', …]`, in item order. */
  labels: string[]
}

export type RefResolution =
  | { ok: true; label: string; gen: number; item: RefItem }
  | { ok: false; stale: boolean; message: string }

/** The design's exact sentence for a ref killed by a navigation. Exported so PR 7's reply path and
 *  the tests share one string — the wording is a contract (it tells the agent to re-read the map). */
export const refStaleMessage = (label: string): string =>
  `${label} is not on the current page (the page navigated since the last --read map; re-read it)`

/** For a label that is simply not in the current map (out of range, or a node that never read a map).
 *  Distinct from stale: nothing navigated, the handle was just never minted here. */
export const refUnknownMessage = (label: string): string =>
  `${label} is not a ref from the last --read map on this page`

interface NodeRefs {
  gen: number
  items: Map<string, RefItem>
}

export class RefTable {
  private readonly byNode = new Map<string, NodeRefs>()
  /** The generation each node's CURRENT labels were minted at. Kept alongside — and NOT cleared by a
   *  bump — so a ref spent after a navigation resolves against the generation the agent read it on and
   *  is therefore reported STALE (the page navigated), not merely "unknown". See {@link spend}. */
  private readonly mintedAt = new Map<string, number>()

  /** The generation the node is currently on (0 before anything is minted or bumped). */
  currentGeneration(nodeId: string): number {
    return this.byNode.get(nodeId)?.gen ?? 0
  }

  /**
   * Mint `@1…@n` for a fresh `--read map`, stamped with `gen`. A mint REPLACES the node's table (a new
   * read supersedes the old one entirely) and establishes `gen` as the current generation.
   */
  mint(nodeId: string, gen: number, items: readonly RefItem[]): MintResult {
    const map = new Map<string, RefItem>()
    const labels: string[] = []
    for (let i = 0; i < items.length; i++) {
      const label = `@${i + 1}`
      labels.push(label)
      map.set(label, items[i])
    }
    this.byNode.set(nodeId, { gen, items: map })
    this.mintedAt.set(nodeId, gen)
    return { gen, labels }
  }

  /**
   * SPEND a ref an agent is holding (`--click @7`, `--type --into @3`, `--wait @9`). It resolves the
   * label at the generation its CURRENT map was minted on — so a navigation since that read (which
   * bumped the generation) surfaces as the STALE refusal (`the page navigated … re-read it`), while a
   * label that was simply never minted on this page is the UNKNOWN refusal. Both are refusals; a stale
   * ref is NEVER silently re-resolved against a newer map (the correctness property PR 5 pins). A node
   * that never read a map at all resolves as stale-shaped (there is nothing to spend), which is still a
   * refusal.
   */
  spend(nodeId: string, label: string): RefResolution {
    return this.resolve(nodeId, this.mintedAt.get(nodeId) ?? 0, label)
  }

  /**
   * Resolve a ref for a node at the generation the agent read it on. Returns the item ONLY when the
   * node's current generation still equals `gen` AND the label was minted then. Anything else is a
   * refusal — a stale refusal (naming the navigation) when the generation moved on, an unknown refusal
   * when the label was never a ref here. NEVER a re-resolution against a different generation's map.
   */
  resolve(nodeId: string, gen: number, label: string): RefResolution {
    const entry = this.byNode.get(nodeId)
    const current = entry?.gen ?? 0
    if (!entry || gen !== current) {
      return { ok: false, stale: true, message: refStaleMessage(label) }
    }
    const item = entry.items.get(label)
    if (!item) {
      return { ok: false, stale: false, message: refUnknownMessage(label) }
    }
    return { ok: true, label, gen: current, item }
  }

  /**
   * The page navigated (or its execution contexts were cleared): advance the generation and drop every
   * ref. The single invalidation path — both CDP events call this, so a ref cannot outlive the page it
   * described.
   */
  bumpGeneration(nodeId: string): number {
    const nextGen = this.currentGeneration(nodeId) + 1
    this.byNode.set(nodeId, { gen: nextGen, items: new Map() })
    return nextGen
  }

  /** Forget a node entirely (its guest is gone / owner released). */
  forget(nodeId: string): void {
    this.byNode.delete(nodeId)
    this.mintedAt.delete(nodeId)
  }
}
