/** Socket lifecycle tests isolate reconnect clocks and transport globals. */
import { afterEach, expect, it, vi } from 'vitest'
import { Mux } from '../src/protocol/mux.ts'

class Socket {
  static readonly OPEN = 1
  static instances: Socket[] = []
  readyState = 0
  sent: string[] = []
  onopen?: () => void
  onclose?: () => void
  onmessage?: (event: { data: string }) => void
  constructor(readonly url: string) {
    Socket.instances.push(this)
  }
  send(value: string): void {
    this.sent.push(value)
  }
  close(): void {
    this.readyState = 3
    this.onclose?.()
  }
  connect(): void {
    this.readyState = 1
    this.onopen?.()
  }
}

let client: Mux | undefined
afterEach(() => {
  client?.close()
  client = undefined
  Socket.instances = []
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

it('opens a pending stream once, reopens it once on reconnect and omits cancelled streams', () => {
  vi.useFakeTimers()
  vi.stubGlobal('WebSocket', Socket)
  vi.stubGlobal('location', { protocol: 'http:', host: 'localhost:3080' })
  client = new Mux()
  const receive = vi.fn()
  const stream = client.open('session/follow', { sessionId: 'analysis' }, { onItem: receive })
  client.start()
  client.start()
  expect(Socket.instances).toHaveLength(1)
  const first = Socket.instances[0]
  expect(first.sent).toEqual([])
  first.connect()
  expect(first.sent).toEqual([
    JSON.stringify({ type: 'open', streamId: stream.streamId, endpoint: 'session/follow', payload: { sessionId: 'analysis' } }),
  ])
  first.onmessage?.({ data: JSON.stringify({ type: 'item', streamId: stream.streamId, value: { seq: 5 } }) })
  expect(receive).toHaveBeenCalledWith({ seq: 5 })
  first.close()
  vi.advanceTimersByTime(1500)
  const second = Socket.instances[1]
  second.connect()
  expect(second.sent).toHaveLength(1)
  stream.cancel()
  expect(JSON.parse(second.sent[1])).toEqual({ type: 'cancel', streamId: stream.streamId })
  second.close()
  vi.advanceTimersByTime(1500)
  Socket.instances[2].connect()
  expect(Socket.instances[2].sent).toEqual([])
})
