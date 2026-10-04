/**
 * Pure-ish fold from the ordered journal event list into everything the UI
 * renders: the chat transcript, the trace turns, and the workflow runs. The
 * fold builds mutable rows in place, but never mutates its input.
 */
import { blocksText, type WireEvent } from '../protocol/wire.ts'

/** One query/inspect tool invocation card in the transcript. */
export interface ToolCard {
  readonly callId: string
  readonly name: string
  readonly turn: number
  readonly step: number
  readonly argsText: string
  readonly args: Record<string, unknown>
  resultText?: string
  meta?: Record<string, unknown>
  isError?: boolean
  startedAt?: number
  endedAt?: number
}

/** One transcript entry, in journal order. */
export type ChatEntry =
  | { readonly kind: 'user'; readonly key: string; readonly seq: number; readonly time: number; readonly text: string }
  | {
    readonly kind: 'assistant'
    readonly key: string
    readonly seq: number
    readonly time: number
    readonly turn: number
    readonly step: number
    readonly text: string
    readonly reasoning?: string
    readonly usage?: Usage
  }
  | {
    readonly kind: 'tool'
    readonly key: string
    readonly seq: number
    readonly time: number
    readonly card: ToolCard
  }
  | {
    readonly kind: 'command'
    readonly key: string
    seq: readonly [number, number | undefined]
    readonly time: number
    readonly name: string
    args?: string
    done?: { ok: boolean; text?: string }
  }

/** Token usage as reported on assistant messages. */
export interface Usage {
  readonly input?: number
  readonly output?: number
  readonly cacheRead?: number
  readonly cacheWrite?: number
}

/** One actual model dispatch, including attempts that produce no assistant message. */
export interface TraceRequest {
  readonly requestId: string
  readonly attempt: number
  readonly startedAt: number
  readonly inputThroughSeq: number
  endedAt?: number
  status?: string
  usage?: Record<string, unknown>
  error?: string
  finish?: string
}

/** One step of the trace timeline. */
export interface TraceStep {
  readonly turn: number
  readonly step: number
  startedAt?: number
  endedAt?: number
  assistantText?: string
  usage?: Usage
  readonly tools: ToolCard[]
  readonly requests: TraceRequest[]
  readonly retries: Array<{ time: number; data: Record<string, unknown> }>
}

/** One turn of the trace timeline. */
export interface TraceTurn {
  readonly turn: number
  startedAt?: number
  endedAt?: number
  reason?: string
  readonly steps: TraceStep[]
}

/** One member (sub-agent) of a workflow run. */
export interface WorkflowMember {
  readonly seq: number
  readonly label: string
  readonly phase?: string
  readonly childId?: string
  outcome?: string
  readonly startedAt: number
  endedAt?: number
}

/** One workflow run. */
export interface WorkflowRun {
  readonly runId: string
  readonly callId?: string
  readonly name: string
  readonly startedAt: number
  endedAt?: number
  stopReason?: string
  readonly members: WorkflowMember[]
  readonly progress: Array<{ time: number; text: string; kind: string }>
}

/** The folded view model for one session. */
export interface JournalView {
  readonly chat: ChatEntry[]
  readonly trace: TraceTurn[]
  readonly workflows: WorkflowRun[]
  /** Whether a turn is open without its end (the agent is working). */
  readonly running: boolean
  /** The current `/db` selection, from the latest successful command. */
  readonly selectedDb?: string
}

/** Read one event data field as a record. */
function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {}
}

/** Coerce one event field to a number. */
function num(value: unknown): number {
  return typeof value === 'number' ? value : 0
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

/** Create a session-local projection for ordered, deduplicated event batches.
 * @returns an append operation shared by live updates and history replay.
 */
export function createJournalFold() {
  const chat: ChatEntry[] = []
  const tools = new Map<string, ToolCard>()
  const commands = new Map<string, Extract<ChatEntry, { kind: 'command' }>>()
  const traceTurns: TraceTurn[] = []
  const steps = new Map<string, TraceStep>()
  const workflows = new Map<string, WorkflowRun>()
  const members = new Map<string, WorkflowMember>()
  const requests = new Map<string, TraceRequest>()
  let selectedDb: string | undefined

  const turnRow = (turn: number): TraceTurn => {
    let row = traceTurns.find(t => t.turn === turn)
    if (row === undefined) {
      row = { turn, steps: [] }
      traceTurns.push(row)
    }
    return row
  }
  const stepOf = (turn: number, step: number): TraceStep => {
    const key = `${turn}:${step}`
    let entry = steps.get(key)
    if (entry === undefined) {
      entry = { turn, step, tools: [], requests: [], retries: [] }
      steps.set(key, entry)
      turnRow(turn).steps.push(entry)
    }
    return entry
  }

  const append = (events: readonly WireEvent[]): JournalView => {
    for (const event of events) {
      const data = asRecord(event.data)
      switch (event.type) {
        case 'user/message': {
          const source = asRecord(data.source)
          const kind = typeof source.kind === 'string' ? source.kind : 'user'
          if (kind !== 'user') break
          const text = blocksText(data.content ?? data.message, ['text'])
          if (text.trim().length === 0) break
          chat.push({ kind: 'user', key: `u${event.seq}`, seq: event.seq, time: event.time, text })
          break
        }
        case 'assistant/message': {
          const message = asRecord(data.message)
          const text = blocksText(message.content, ['text'])
          const reasoning = blocksText(message.content, ['reasoning'])
          const usage = asRecord(data.usage)
          const view: Usage = {
            input: typeof usage.inputTokens === 'number' ? usage.inputTokens : undefined,
            output: typeof usage.outputTokens === 'number' ? usage.outputTokens : undefined,
            cacheRead: typeof usage.cacheReadTokens === 'number' ? usage.cacheReadTokens : undefined,
            cacheWrite: typeof usage.cacheWriteTokens === 'number' ? usage.cacheWriteTokens : undefined,
          }
          const turn = num(data.turn)
          const step = num(data.step)
          chat.push({
            kind: 'assistant',
            key: `a${event.seq}`,
            seq: event.seq,
            time: event.time,
            turn,
            step,
            text,
            reasoning: reasoning.length > 0 ? reasoning : undefined,
            usage: view.input === undefined && view.output === undefined ? undefined : view,
          })
          const row = stepOf(turn, step)
          row.assistantText = text
          row.usage = view
          break
        }
        case 'tool/call': {
          let args: Record<string, unknown> = {}
          try {
            const parsed: unknown = JSON.parse(typeof data.arguments === 'string' ? data.arguments : '{}')
            if (typeof parsed === 'object' && parsed !== null) args = parsed as Record<string, unknown>
          } catch (_error) {
            /* Malformed model JSON remains available as raw text. */
          }
          const card: ToolCard = {
            callId: str(data.callId),
            name: str(data.name),
            turn: num(data.turn),
            step: num(data.step),
            argsText: typeof data.arguments === 'string' ? data.arguments : '',
            args,
            startedAt: event.time,
          }
          tools.set(card.callId, card)
          stepOf(card.turn, card.step).tools.push(card)
          chat.push({ kind: 'tool', key: `t${event.seq}`, seq: event.seq, time: event.time, card })
          break
        }
        case 'tool/result': {
          const callId = str(asRecord(data.message).toolCallId)
          const card = tools.get(callId)
          if (card === undefined) break
          card.resultText = blocksText(data.message, ['text'])
          card.meta =
            typeof data.meta === 'object' && data.meta !== null ? (data.meta as Record<string, unknown>) : undefined
          card.isError = asRecord(data.message).isError === true
          card.endedAt = event.time
          break
        }
        case 'command/run': {
          const entry: Extract<ChatEntry, { kind: 'command' }> = {
            kind: 'command',
            key: `c${event.seq}`,
            seq: [event.seq, undefined],
            time: event.time,
            name: str(data.name),
            args: typeof data.args === 'string' ? data.args : undefined,
          }
          commands.set(str(data.commandId), entry)
          chat.push(entry)
          break
        }
        case 'command/done': {
          const entry = commands.get(str(data.commandId))
          if (entry === undefined) break
          entry.done = { ok: data.kind === 'success', text: typeof data.text === 'string' ? data.text : undefined }
          entry.seq = [entry.seq[0], event.seq]
          const arg = entry.args?.trim() ?? ''
          if (entry.name === 'db' && entry.done.ok && arg.length > 0 && arg.toLowerCase() !== 'list') {
            selectedDb = arg.toLowerCase() === 'clear' ? undefined : arg
          }
          if (entry.name === 'data_scope' && entry.done.ok && entry.done.text?.startsWith('data-agent-scope:')) {
            const scope = asRecord(JSON.parse(entry.done.text.slice('data-agent-scope:'.length)))
            selectedDb = typeof scope.defaultDatabase === 'string' ? scope.defaultDatabase : undefined
          }
          break
        }
        case 'turn/start':
          turnRow(num(data.turn)).startedAt = event.time
          break
        case 'turn/end': {
          const row = turnRow(num(data.turn))
          row.endedAt = event.time
          row.reason = typeof data.reason === 'string' ? data.reason : str(asRecord(data.reason).kind)
          break
        }
        case 'step/start':
          stepOf(num(data.turn), num(data.step)).startedAt = event.time
          break
        case 'data-agent/request': {
          const request: TraceRequest = {
            requestId: str(data.requestId),
            attempt: num(data.attempt),
            startedAt: event.time,
            inputThroughSeq: num(data.inputThroughSeq),
          }
          requests.set(request.requestId, request)
          stepOf(num(data.turn), num(data.step)).requests.push(request)
          break
        }
        case 'data-agent/request-end': {
          const request = requests.get(str(data.requestId))
          if (request !== undefined) {
            request.endedAt = event.time
            request.status = str(data.status)
            request.usage = typeof data.usage === 'object' && data.usage !== null ? asRecord(data.usage) : undefined
            request.error = typeof data.error === 'string' ? data.error : undefined
            request.finish = typeof data.finish === 'string' ? data.finish : undefined
          }
          break
        }
        case 'llm/retry':
        case 'llm/retry-started':
          stepOf(num(data.turn), num(data.step)).retries.push({ time: event.time, data })
          break
        case 'step/end':
          stepOf(num(data.turn), num(data.step)).endedAt = event.time
          break
        case 'tool-workflow/run-start': {
          const runId = str(data.runId)
          workflows.set(runId, {
            runId,
            callId: typeof data.callId === 'string' ? data.callId : undefined,
            name: str(data.name, 'workflow'),
            startedAt: event.time,
            members: [],
            progress: [],
          })
          break
        }
        case 'tool-workflow/agent-start': {
          const run = workflows.get(str(data.runId))
          if (run === undefined) break
          const member: WorkflowMember = {
            seq: num(data.seq),
            label: str(data.label, `agent-${num(data.seq)}`),
            phase: typeof data.phase === 'string' ? data.phase : undefined,
            childId: typeof data.childId === 'string' ? data.childId : undefined,
            startedAt: event.time,
          }
          members.set(`${str(data.runId)}:${member.seq}`, member)
          run.members.push(member)
          break
        }
        case 'tool-workflow/agent-end': {
          const member = members.get(`${str(data.runId)}:${num(data.seq)}`)
          if (member === undefined) break
          member.outcome = typeof data.outcome === 'string' ? data.outcome : JSON.stringify(data.outcome ?? '')
          member.endedAt = event.time
          break
        }
        case 'tool-workflow/run-end': {
          const run = workflows.get(str(data.runId))
          if (run === undefined) break
          run.endedAt = event.time
          run.stopReason = typeof data.stopReason === 'string' ? data.stopReason : undefined
          break
        }
        case 'tool-workflow/phase':
        case 'tool-workflow/log':
          workflows
            .get(str(data.runId))
            ?.progress.push({ time: event.time, text: str(data.title ?? data.message), kind: event.type })
          break
        default:
          break
      }
    }

    for (const turn of traceTurns) {
      turn.steps.sort((a, b) => a.step - b.step)
      const first = turn.steps.find(s => s.startedAt !== undefined)
      if (turn.startedAt === undefined && first?.startedAt !== undefined) turn.startedAt = first.startedAt
    }
    traceTurns.sort((a, b) => a.turn - b.turn)

    return {
      chat,
      trace: traceTurns,
      workflows: [...workflows.values()],
      running: traceTurns.some(turn => turn.endedAt === undefined),
      selectedDb,
    }
  }
  return { append }
}

/** Replay a complete immutable journal with the same incremental projection. */
export function foldJournal(events: readonly WireEvent[]): JournalView {
  return createJournalFold().append(events)
}
