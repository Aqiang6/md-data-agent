/**
 * WebSocket mux client for `/api/remote.mux`: multiplexes logical streams
 * (open/item/error/end frames), auto-reconnects, and re-opens every live
 * stream after a reconnect so subscribers survive server restarts.
 */
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'

export interface MuxHandlers {
  /** One downlink item for this stream (snapshot, event, projection...). */
  onItem: (value: unknown) => void
  /** The stream failed host-side. */
  onError?: (error: { code: string; message: string }) => void
  /** The stream ended (half-close). */
  onEnd?: () => void
}

interface LiveStream {
  readonly endpoint: string
  readonly payload: unknown
  readonly handlers: MuxHandlers
}

interface MuxFrame {
  type: string
  streamId?: string
  endpoint?: string
  payload?: unknown
  value?: unknown
  error?: { code: string; message: string }
}

/** Multiplexed stream client with transparent reconnect and re-subscribe. */
export class Mux {
  private ws: WebSocket | undefined
  private readonly live = new Map<string, LiveStream>()
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined
  private closed = false

  /**
   * Open one logical stream; returns its id and a cancel function. Handlers
   * survive reconnects (the stream is re-opened transparently).
   */
  open(endpoint: string, payload: unknown, handlers: MuxHandlers): { streamId: string; cancel: () => void } {
    const streamId = randomUUID()
    this.live.set(streamId, { endpoint, payload, handlers })
    this.send({ type: 'open', streamId, endpoint, payload })
    return {
      streamId,
      cancel: () => {
        this.live.delete(streamId)
        this.send({ type: 'cancel', streamId })
      },
    }
  }

  /** Connect (or re-connect) the socket; safe to call repeatedly. */
  start(): void {
    if (this.closed || (this.ws !== undefined && this.ws.readyState <= WebSocket.OPEN)) return
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const ws = new WebSocket(`${protocol}//${location.host}/api/remote.mux`)
    this.ws = ws
    ws.onopen = () => {
      // Connecting streams and reconnecting streams use the same single open.
      for (const [streamId, stream] of this.live) {
        ws.send(JSON.stringify({ type: 'open', streamId, endpoint: stream.endpoint, payload: stream.payload }))
      }
    }
    ws.onmessage = (event) => {
      let frame: MuxFrame
      try {
        frame = JSON.parse(String(event.data)) as MuxFrame
      } catch {
        return
      }
      this.dispatch(frame)
    }
    ws.onclose = () => {
      if (this.closed) return
      this.reconnectTimer = setTimeout(() => {
        this.start()
      }, 1500)
    }
  }

  /** Stop the client for good. */
  close(): void {
    this.closed = true
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer)
    this.ws?.close()
  }

  private dispatch(frame: MuxFrame): void {
    if (frame.streamId === undefined) return
    const stream = this.live.get(frame.streamId)
    if (stream === undefined) return
    if (frame.type === 'item') stream.handlers.onItem(frame.value)
    else if (frame.type === 'error')
      stream.handlers.onError?.(frame.error ?? { code: 'error', message: 'stream error' })
    else if (frame.type === 'end') {
      stream.handlers.onEnd?.()
      this.live.delete(frame.streamId)
    }
  }

  private send(frame: MuxFrame): void {
    if (this.ws !== undefined && this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame))
  }
}
