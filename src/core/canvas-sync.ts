// Canvas sync — the reflector.
//
// Every attached client (an Electron renderer, a Server-Edition browser tab) casts its LOCAL node
// mutations on `canvas:mut`. This service sends each one back out on the same channel to every
// OTHER attached client, so all clients converge on the same node set — a teammate's cursor never
// hovers over stale geometry, and a client whose canvas still held a node someone else deleted can
// no longer write it back on the next whole-file workspace.save.
//
// It is a pipe, not a store: it holds NO canvas state, applies no policy, and persists nothing.
// The canvas itself stays where it has always been — React Flow in each renderer — and the disk
// write stays with WorkspaceStore. Echo suppression is by sender ClientId: a client must never
// receive its own mutation back (it would fight its own optimistic state, and with the renderer's
// diff-publisher it would loop).
//
// NOT RATE-LIMITED, deliberately — unlike presence (see PRESENCE_RATE_BUDGETS). A presence cast is
// a SAMPLED signal whose loss is self-correcting: the next cursor frame carries the current
// position. A mutation is an EDGE: nothing supersedes it and nothing re-announces it, so a dropped
// one is LOST STATE — a node that never appears on a peer's canvas, or a delete that never lands
// (and then gets written back to disk by that peer's next save, which is the very bug Stage 3
// exists to fix). Legitimate traffic is also burstier than any bucket sized for it would survive:
// a drag emits at 20 Hz, and a bulk delete emits N mutations in ONE tick. What IS bounded is the
// PAYLOAD (see isCanvasMutation): an oversized or malformed mutation is refused at ingest, so a
// hostile cast cannot amplify into every peer's socket or wedge a peer's React Flow. If a budget
// is ever needed here, it must queue — never drop.
//
// No electron, no ws, no disk (see no-electron.test.ts).

import { platform, type CorePlatform } from './platform'
import { IPC } from '../shared/ipc'
import { REF_MAX_LEN, type ClientId } from '../shared/presence'
import type { CanvasMutation } from '../shared/types'

/**
 * Ceiling on one mutation's serialized size. A node carries free text (a sticky's body, an
 * editor's path), and the whole object is reflected verbatim to every peer — so an unbounded one
 * is an N-way amplifier straight into everyone's WS send buffer (the same sink pty output rides).
 * 256 KB is orders of magnitude past any real node and cannot refuse a legitimate edit.
 */
export const MUTATION_MAX_BYTES = 256_000

/** Every attached client except the sender. Pure — exported for the test. */
export function reflectTargets(all: ClientId[], sender: ClientId): ClientId[] {
  return all.filter((id) => id !== sender)
}

/** An id off the wire: non-empty and bounded by the shared ref cap (node ids and project ids are
 *  short and generated — `term-ab12`, `project-1` — so this can never refuse a real one). Ids are
 *  REJECTED, never truncated: a truncated id would address the WRONG node on every peer. */
function isRefId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= REF_MAX_LEN
}

/**
 * Shape + size guard: a client cast is untrusted input, and it is reflected to every peer as-is.
 * A malformed payload would wedge a peer's React Flow (applyCanvasMutation would upsert a node with
 * no id, or a NaN position, which React Flow cannot lay out); an oversized one would flood their
 * sockets. Drop it here — the reflector never throws, and never keys anything by a wire string.
 */
export function isCanvasMutation(value: unknown): value is CanvasMutation {
  if (!value || typeof value !== 'object') return false
  const m = value as { op?: unknown; id?: unknown; node?: unknown }
  if (m.op === 'remove') return isRefId(m.id)
  if (m.op !== 'upsert') return false
  const node = m.node as { id?: unknown; position?: { x?: unknown; y?: unknown } } | undefined
  if (!node || typeof node !== 'object') return false
  if (!isRefId(node.id)) return false
  const pos = node.position
  if (!pos || typeof pos !== 'object') return false
  if (!Number.isFinite(pos.x) || !Number.isFinite(pos.y)) return false
  return withinSizeLimit(m)
}

function withinSizeLimit(m: unknown): boolean {
  try {
    // The wire form is JSON on the server and a structured clone on the desktop; either way this
    // is a faithful measure of what would be pushed to every peer. A value that cannot even be
    // stringified (BigInt, a cycle) is not something we should be reflecting.
    return JSON.stringify(m).length <= MUTATION_MAX_BYTES
  } catch {
    return false
  }
}

/** The platform this reflector is already installed on. `on`/`onWithSender` COMPOSE on the same
 *  channel (ServerPlatform keeps an ordered SET per channel), so a second registration on the same
 *  platform would reflect every mutation twice. Keyed by platform, not a bare boolean, so a fresh
 *  boot (or a fresh test platform) registers again. */
let registeredOn: CorePlatform | null = null

/** Install the `canvas:mut` reflector. Call once at boot, after initPlatform(). */
export function initCanvasSync(): void {
  const p = platform()
  if (registeredOn === p) return
  registeredOn = p
  p.onWithSender(IPC.canvasMut, (senderId: number, projectId: unknown, mutation: unknown) => {
    // Which canvas the edit belongs to is client-supplied too, and it is reflected verbatim.
    if (!isRefId(projectId)) return
    if (!isCanvasMutation(mutation)) return
    for (const id of reflectTargets(p.clientIds(), senderId)) {
      p.sendTo(id, IPC.canvasMut, projectId, mutation)
    }
  })
}
