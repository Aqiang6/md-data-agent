/** Recover recorded preset identities from live hints and cold Session projections. */
import { afterEach, expect, it, vi } from 'vitest'
import { listSessions } from '../src/protocol/api.ts'
import { analysisHistory } from '../src/state/analysis-history.ts'

afterEach(() => { vi.unstubAllGlobals() })

it('uses current preset projections and resolves cold records without prompting or creating agents', async () => {
  const calls: string[] = []
  const record = (sessionId: string) => ({ sessionId, updatedAt: 1, running: false, blank: false })
  vi.stubGlobal('fetch', async (url: string, request: RequestInit) => {
    calls.push(url)
    if (typeof request.body !== 'string') throw new Error('Expected a JSON request body')
    const envelope = JSON.parse(request.body) as { payload: { args: { request?: { sessionId: string } } } }
    const value = url === '/api/session/list' ? { items: [
      { ...record('live-analysis'), projections: { values: { agentPreset: 'data-agent' } } },
      { ...record('live-coding'), projections: { values: { agentPreset: 'standard' } } },
      record('cold-analysis'), record('cold-coding'), record('unknown'),
      { ...record('child'), parentSessionId: 'live-analysis' },
    ] } : envelope.payload.args.request?.sessionId === 'unknown' ? null : {
      values: { agentPreset: envelope.payload.args.request?.sessionId === 'cold-analysis' ? 'data-agent' : 'standard' },
    }
    return new Response(JSON.stringify({ type: 'server-response', rpcId: 'fixture-response', result: { ok: true, value } }))
  })
  const result = await listSessions()
  expect(analysisHistory(result.items, []).map(item => item.sessionId)).toEqual(['live-analysis', 'cold-analysis'])
  expect(calls).toEqual(['/api/session/list', '/api/session/projections', '/api/session/projections', '/api/session/projections'])
})
