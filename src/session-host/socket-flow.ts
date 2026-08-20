import type { Socket } from 'net'
import type { HostSession } from './session'

/** Write one accepted-connection frame without mistaking named-pipe backpressure for delivery
 * failure. A net.Socket queue is shared by every session on that connection, so the first false
 * return books a transport pause against every subscribed session, not only the frame's source. */
export function writeSessionHostFrame(
  socket: Socket,
  frame: string,
  sessions: Iterable<HostSession>
): void {
  try {
    if (socket.write(frame)) return
  } catch {
    // A synchronous send failure is a dead transport, not a failed dispatch that should generate
    // a second response. Destroying it funnels all ownership cleanup through the close handler.
    socket.destroy()
    return
  }
  for (const session of sessions) {
    if (session.subscribers.has(socket)) session.pauseTransportFor(socket)
  }
}

/** A socket drain returns only the named-pipe transport ticket. Explicit renderer flow and the
 * session-global emulator queue have independent drain events and remain held. */
export function drainSessionHostTransport(
  socket: Socket,
  sessions: Iterable<HostSession>
): void {
  for (const session of sessions) {
    if (session.subscribers.has(socket)) session.resumeTransportFor(socket)
  }
}
