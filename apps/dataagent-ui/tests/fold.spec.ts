/** Journal projection tests use the public wire fields, without a model or browser. */
import { expect, it } from 'vitest'
import { createJournalFold, foldJournal } from '../src/state/fold.ts'
import type { WireEvent } from '../src/protocol/wire.ts'

function journal(rows: Array<[string, Record<string, unknown>]>): WireEvent[] {
  return rows.map(([type, data], seq) => ({ type, data, seq, time: 1000 + seq * 10 }))
}

it('projects completion kinds for report choices without treating cancellation or failure as success', () => {
  const result = foldJournal(journal([
    ['turn/end', { turn: 1, reason: { kind: 'completed' } }],
    ['turn/end', { turn: 2, reason: { kind: 'cancelled' } }],
    ['turn/end', { turn: 3, reason: { kind: 'error', error: 'Unavailable' } }],
    ['turn/end', { turn: 4, reason: 'stop' }],
  ]))
  expect(result.trace.map(turn => turn.reason)).toMatchInlineSnapshot(`
    [
      "completed",
      "cancelled",
      "error",
      "stop",
    ]
  `)
})

it.each([1, 2])('restores the default source from selection version %s and ignores failed commands', (version) => {
  const scope = {
    version,
    sources: [{ database: 'sales', ...(version === 1 ? { tables: ['tickets'] } : {}) }],
    defaultDatabase: 'sales',
  }
  const result = foldJournal(
    journal([
      ['command/run', { commandId: 'scope', name: 'data_scope', args: JSON.stringify(scope) }],
      [
        'command/done',
        { commandId: 'scope', kind: 'success', text: `data-agent-scope:${JSON.stringify(scope)}` },
      ],
      ['command/run', { commandId: 'bad', name: 'data_scope', args: '{}' }],
      ['command/done', { commandId: 'bad', kind: 'error', text: 'Invalid selection' }],
    ]),
  )
  expect(result.selectedDb).toBe('sales')
})

it('renders actual user content, usage fields and separate request/tool durations in live and history views', () => {
  const events = journal([
    ['user/message', { source: { kind: 'user' }, content: [{ type: 'text', text: 'Count orders.' }] }],
    ['turn/start', { turn: 1 }],
    ['step/start', { turn: 1, step: 1 }],
    ['data-agent/request', { requestId: 'first', turn: 1, step: 1, attempt: 1, inputThroughSeq: 2 }],
    ['data-agent/request-end', { requestId: 'first', status: 'failed', error: 'Rate limited' }],
    ['llm/retry-started', { turn: 1, step: 1, delayMs: 100 }],
    ['data-agent/request', { requestId: 'second', turn: 1, step: 1, attempt: 2, inputThroughSeq: 5 }],
    [
      'data-agent/request-end',
      {
        requestId: 'second',
        status: 'completed',
        usage: { inputTokens: 27, outputTokens: 8, cacheReadTokens: 10 },
      },
    ],
    [
      'assistant/message',
      {
        turn: 1,
        step: 1,
        message: { content: [{ type: 'text', text: 'Querying.' }] },
        usage: { inputTokens: 27, outputTokens: 8, cacheReadTokens: 10 },
      },
    ],
    [
      'tool/call',
      {
        turn: 1,
        step: 1,
        callId: 'query',
        name: 'query_database',
        arguments: '{"sql":"SELECT COUNT(*) FROM orders"}',
      },
    ],
    [
      'tool/result',
      {
        message: { toolCallId: 'query', content: [{ type: 'text', text: 'Read result MD.' }] },
        meta: { resultId: 'result', rowCount: 1 },
      },
    ],
    ['step/end', { turn: 1, step: 1 }],
    ['turn/end', { turn: 1, reason: 'stop' }],
  ])
  const original = structuredClone(events)
  const live = createJournalFold()
  expect(live.append(events.slice(0, 7)).running).toBe(true)
  const result = live.append(events.slice(7))
  expect(result).toEqual(foldJournal(events))
  expect(events).toEqual(original)
  expect(result.chat[0]).toMatchObject({ kind: 'user', text: 'Count orders.' })
  expect(result.trace[0]).toMatchObject({ startedAt: events[1].time, endedAt: events[12].time })
  const step = result.trace[0].steps[0]
  expect(step.requests.map(request => request.status)).toEqual(['failed', 'completed'])
  expect(step.requests[0].usage).toBeUndefined()
  expect(step.usage).toEqual({ input: 27, output: 8, cacheRead: 10, cacheWrite: undefined })
  expect(step.requests[1].endedAt).toBeLessThan(step.tools[0].startedAt!)
  expect(step.tools[0]).toMatchObject({ resultText: 'Read result MD.', meta: { rowCount: 1 } })
  expect(result.running).toBe(false)
})

it('restores database selection only after a successful command and preserves it after failures', () => {
  const events = journal([
    ['command/run', { commandId: 'a', name: 'db', args: 'shop.db' }],
    ['command/done', { commandId: 'a', kind: 'success' }],
    ['command/run', { commandId: 'b', name: 'db', args: 'missing.db' }],
    ['command/done', { commandId: 'b', kind: 'error' }],
    ['command/run', { commandId: 'c', name: 'db', args: 'list' }],
    ['command/done', { commandId: 'c', kind: 'success' }],
    ['command/run', { commandId: 'd', name: 'db', args: 'clear' }],
    ['command/done', { commandId: 'd', kind: 'success' }],
  ])
  expect(foldJournal(events.slice(0, 1)).selectedDb).toBeUndefined()
  expect(foldJournal(events.slice(0, 6)).selectedDb).toBe('shop.db')
  expect(foldJournal(events).selectedDb).toBeUndefined()
})

it('keeps concurrent workflow children and progress attached to their recorded run', () => {
  const result = foldJournal(
    journal([
      ['tool-workflow/run-start', { runId: 'run', name: 'Analysis', callId: 'workflow-call' }],
      ['tool-workflow/phase', { runId: 'run', title: 'Inspect' }],
      ['tool-workflow/agent-start', { runId: 'run', seq: 1, label: 'Schema', childId: 'child-a' }],
      ['tool-workflow/agent-start', { runId: 'run', seq: 2, label: 'Metrics', childId: 'child-b' }],
      ['tool-workflow/log', { runId: 'run', message: 'Computing' }],
      ['tool-workflow/agent-end', { runId: 'run', seq: 2, outcome: 'completed' }],
      ['tool-workflow/agent-end', { runId: 'run', seq: 1, outcome: 'cancelled' }],
      ['tool-workflow/run-end', { runId: 'run', stopReason: 'completed' }],
    ]),
  )
  expect(result.workflows[0].members).toMatchObject([
    { childId: 'child-a', outcome: 'cancelled' },
    { childId: 'child-b', outcome: 'completed' },
  ])
  expect(result.workflows[0].callId).toBe('workflow-call')
  expect(result.workflows[0].progress.map(row => row.text)).toEqual(['Inspect', 'Computing'])
})

it('keeps old steps without fabricated requests and retains malformed tool arguments', () => {
  const result = foldJournal(
    journal([
      ['step/start', { turn: 1, step: 1 }],
      ['tool/call', { turn: 1, step: 1, name: 'query_database', callId: 'bad', arguments: '{' }],
      [
        'tool/result',
        { message: { toolCallId: 'bad', isError: true, content: [{ type: 'text', text: 'Invalid input' }] } },
      ],
    ]),
  )
  expect(result.trace[0].steps[0].requests).toEqual([])
  expect(result.trace[0].steps[0].tools[0]).toMatchObject({ argsText: '{', args: {}, isError: true })
})
