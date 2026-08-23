import net from 'net'
import { LineFramer, encodeFrame } from './protocol'

const HELLO_PROBE_ID = 0

/** One bounded liveness check for an ownership-state endpoint. Only the response correlated to the
 * exact hello request can decide the result; an unrelated queued `{ok:true}` frame is not proof
 * that this host accepted our token. */
export function trySessionHostHello(
  endpoint: string,
  token: string,
  timeoutMs: number
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const socket = net.connect(endpoint)
    const finish = (ok: boolean): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        socket.destroy()
      } catch {
        /* already gone */
      }
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.once('error', () => finish(false))
    socket.once('connect', () => {
      socket.write(encodeFrame({ id: HELLO_PROBE_ID, cmd: 'hello', token }))
    })
    const framer = new LineFramer()
    socket.on('data', (chunk: Buffer) => {
      let frames: { id: number; ok?: boolean }[]
      try {
        frames = framer.push<{ id: number; ok?: boolean }>(chunk.toString('utf8'))
      } catch {
        // Whatever answered streamed an oversized un-terminated line — treat the probe as a
        // negative (this endpoint is not a healthy host) rather than buffer it.
        finish(false)
        return
      }
      for (const frame of frames) {
        if (frame.id !== HELLO_PROBE_ID) continue
        finish(frame.ok === true)
      }
    })
  })
}
