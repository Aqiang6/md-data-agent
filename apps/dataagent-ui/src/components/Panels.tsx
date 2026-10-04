/** Unified execution tree: model attempts, tool observations, and workflow children. */
import { useEffect, useMemo, useState } from 'react'
import { Download, Maximize2, X, ChevronRight } from 'lucide-react'
import type {
  TraceRequest,
  TraceStep,
  TraceTurn,
  WorkflowRun,
} from '../state/fold.ts'
import { foldJournal } from '../state/fold.ts'
import { Mux } from '../protocol/mux.ts'
import type { HistoryRecord, WireEvent } from '../protocol/wire.ts'
import { rpc } from '../protocol/api.ts'
import { durationOf } from './Chat.tsx'
import { Markdown } from './Markdown.tsx'
import { ArtifactLinks } from './Artifacts.tsx'
import { RequestTools } from './RequestTools.tsx'
import { t } from '../copy.ts'

type Section = 'system' | 'context' | 'tools' | 'info' | 'raw'

function statusLabel(status?: string): string {
  switch (status) {
    case undefined:
    case 'running':
      return t('running')
    case 'completed':
      return t('completed')
    case 'failed':
      return t('failed')
    case 'cancelled':
      return t('cancelled')
    default:
      return status
  }
}

/** Inspect complete Markdown and JSON sections from the actual request.
 * @param props - Owning session, observed request, and close action.
 * @returns Read-only desktop detail panel.
 */
export function RequestInspector({
  sessionId,
  request,
  dismiss,
}: {
  sessionId: string
  request: TraceRequest
  dismiss: () => void
}) {
  const [section, setSection] = useState<Section>('system')
  const [raw, setRaw] = useState<string>()
  const [error, setError] = useState<string>()
  const [wide, setWide] = useState(false)
  const download = `/api/trace/request-download?${new URLSearchParams({
    sessionId, requestId: request.requestId, section,
  })}`
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dismiss()
    }
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('keydown', onKey)
    }
  }, [dismiss])
  useEffect(() => {
    const controller = new AbortController()
    setRaw(undefined)
    setError(undefined)
    fetch(download, { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) {
          const value = (await response.json()) as { error?: string }
          throw new Error(value.error ?? t('unavailable'))
        }
        const value = await response.text()
        if (!controller.signal.aborted) setRaw(value)
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(String(cause))
      })
    return () => {
      controller.abort()
    }
  }, [download])
  return (
    <section
      className={`request-inspector${wide ? ' wide' : ''}`}
      aria-label={t('request')}
    >
      <header>
        <span>
          {t('request')} · {t('attempt')} {request.attempt}
        </span>
        <a href={download} title={t('downloadComplete')} aria-label={t('downloadComplete')}>
          <Download size={16} />
        </a>
        <button
          title={t('expand')}
          onClick={() => {
            setWide(!wide)
          }}
        >
          <Maximize2 size={16} />
        </button>
        <button title={t('close')} onClick={dismiss}>
          <X size={16} />
        </button>
      </header>
      <nav>
        {(['system', 'context', 'tools', 'info', 'raw'] as const).map(key => (
          <button
            key={key}
            className={key === section ? 'selected' : ''}
            onClick={() => {
              setSection(key)
            }}
          >
            {key === 'tools' ? t('declarations') : t(key)}
          </button>
        ))}
      </nav>
      <p className="request-status">
        {statusLabel(request.status)} ·{' '}
        {durationOf(request.startedAt, request.endedAt)}
      </p>
      <dl className="request-usage">
        {(
          [
            'inputTokens',
            'outputTokens',
            'cacheReadTokens',
            'cacheWriteTokens',
          ] as const
        ).map((key, index) => (
          <div key={key}>
            <dt>
              {t(
                (['input', 'outputTokens', 'cacheRead', 'cacheWrite'] as const)[
                  index
                ],
              )}
            </dt>
            <dd>
              {typeof request.usage?.[key] === 'number'
                ? String(request.usage[key])
                : t('unavailable')}
            </dd>
          </div>
        ))}
      </dl>
      {request.finish && (
        <p>
          {t('finish')}: {request.finish}
        </p>
      )}
      {request.error && <p role="alert">{request.error}</p>}
      <div className="request-content" key={`${request.requestId}:${section}`}>
        {error ? (
          <p role="alert">{error}</p>
        ) : raw === undefined ? (
          <p>{t('loading')}</p>
        ) : section === 'tools' ? (
          <RequestTools raw={raw} />
        ) : section === 'raw' || section === 'info' ? (
          <pre>{raw}</pre>
        ) : (
          <Markdown text={raw} renderImages={false} />
        )}
      </div>
      {raw !== undefined && (
        <footer>
          <span>
            {t('completeContent')} · {raw.length} {t('characters')}
          </span>
        </footer>
      )}
    </section>
  )
}

function MemberTree({
  parentId,
  childId,
  label,
  phase,
  outcome,
  startedAt,
  endedAt,
  depth,
}: {
  parentId: string
  childId?: string
  label: string
  phase?: string
  outcome?: string
  startedAt?: number
  endedAt?: number
  depth: number
}) {
  const [expanded, setExpanded] = useState(false)
  return (
    <details
      className="execution-member"
      onToggle={(event) => {
        setExpanded(event.currentTarget.open)
      }}
    >
      <summary>
        {label}
        {phase && (
          <span>
            {t('phase')}: {phase}
          </span>
        )}
        <span>
          {outcome ?? t('running')} · {durationOf(startedAt, endedAt)}
        </span>
      </summary>
      {expanded &&
        (childId && depth < 12 ? (
          <ChildTree parentId={parentId} childId={childId} depth={depth + 1} />
        ) : (
          <p>{t('unavailable')}</p>
        ))}
    </details>
  )
}

function ChildTree({
  parentId,
  childId,
  depth,
}: {
  parentId: string
  childId: string
  depth: number
}) {
  const [events, setEvents] = useState<WireEvent[]>([])
  const [error, setError] = useState<string>()
  useEffect(() => {
    let disposed = false
    const mux = new Mux()
    const address = {
      kind: 'subagent',
      parentSessionId: parentId,
      childSessionId: childId,
      mode: 'unknown',
    }
    const merge = (incoming: readonly WireEvent[]) => {
      if (!disposed)
        setEvents(previous =>
          [
            ...new Map(
              [...previous, ...incoming].map(event => [event.seq, event]),
            ).values(),
          ].sort((a, b) => a.seq - b.seq),
        )
    }
    const backfill = async (before: number) => {
      while (!disposed && before > 0) {
        const result = await rpc<{
          records: HistoryRecord[]
          hasMore: boolean
        }>('session/page', {
          request: { address, throughSeq: before - 1, maxMessages: 100 },
        })
        merge(result.records.map(record => record.event))
        if (!result.hasMore || result.records.length === 0) break
        before = result.records[0].event.seq
      }
    }
    mux.start()
    const subscription = mux.open(
      'session/follow',
      { args: { request: { address } } },
      {
        onItem: (value) => {
          const item = value as {
            type: string
            event?: WireEvent
            records?: HistoryRecord[]
            hasMore?: boolean
          }
          if (item.event) merge([item.event])
          if (item.records) {
            merge(item.records.map(record => record.event))
            if (item.hasMore && item.records.length)
              void backfill(item.records[0].event.seq).catch(
                (cause: unknown) => {
                  if (!disposed) setError(String(cause))
                },
              )
          }
        },
        onError: (cause) => {
          if (!disposed) setError(cause.message)
        },
      },
    )
    return () => {
      disposed = true
      subscription.cancel()
      mux.close()
    }
  }, [parentId, childId])
  const view = useMemo(() => foldJournal(events), [events])
  return (
    <div className="child-tree">
      {error ? (
        <p role="alert">{error}</p>
      ) : (
        <ExecutionPanel
          sessionId={childId}
          turns={view.trace}
          runs={view.workflows}
          depth={depth}
        />
      )}
    </div>
  )
}

function StepRow({
  sessionId,
  step,
  inspect,
  runsByCall,
  depth,
}: {
  sessionId: string
  step: TraceStep
  inspect: (request: TraceRequest) => void
  runsByCall: ReadonlyMap<string, readonly WorkflowRun[]>
  depth: number
}) {
  return (
    <details className="execution-step" open={step.endedAt === undefined}>
      <summary>
        {t('step')} {step.step}
        <span>
          {step.requests.length} {t('request')} · {step.tools.length}{' '}
          {t('tools')} · {durationOf(step.startedAt, step.endedAt)}
        </span>
      </summary>
      {!step.requests.length && <p className="panel-empty">{t('missing')}</p>}
      {step.requests.map(request => (
        <button
          className={`execution-request ${request.status ?? 'running'}`}
          data-request-id={request.requestId}
          key={request.requestId}
          onClick={() => {
            inspect(request)
          }}
        >
          <ChevronRight size={14} />
          {t('attempt')} {request.attempt}
          <span>
            {statusLabel(request.status)} ·{' '}
            {durationOf(request.startedAt, request.endedAt)}
          </span>
        </button>
      ))}
      {step.retries.map((retry, index) => (
        <details key={index}>
          <summary>
            {t('retry')} ·{' '}
            {typeof retry.data.delayMs === 'number'
              ? retry.data.delayMs
              : t('unavailable')}{' '}
            ms
          </summary>
          <pre>{JSON.stringify(retry.data, null, 2)}</pre>
        </details>
      ))}
      {step.tools.map(tool => (
        <details
          key={tool.callId}
          className={`execution-tool${tool.isError ? ' failed' : ''}`}
        >
          <summary>
            {tool.name}
            <span>{durationOf(tool.startedAt, tool.endedAt)}</span>
          </summary>
          <h4>{t('args')}</h4>
          <pre>{tool.argsText}</pre>
          <h4>{t('result')}</h4>
          <pre>{tool.resultText ?? t('running')}</pre>
          {tool.meta && <pre>{JSON.stringify(tool.meta, null, 2)}</pre>}
          <ArtifactLinks value={tool.meta} />
          {runsByCall.get(tool.callId)?.map(run => (
            <WorkflowNode
              key={run.runId}
              sessionId={sessionId}
              run={run}
              depth={depth}
            />
          ))}
        </details>
      ))}
      {step.assistantText && (
        <details>
          <summary>{t('output')}</summary>
          <Markdown text={step.assistantText} />
        </details>
      )}
      <span className="execution-session-id">{sessionId}</span>
    </details>
  )
}

function WorkflowNode({
  sessionId,
  run,
  depth,
}: {
  sessionId: string
  run: WorkflowRun
  depth: number
}) {
  return (
    <details className="execution-workflow">
      <summary>
        {t('workflow')} · {run.name}
        <span>{run.stopReason ?? t('running')}</span>
      </summary>
      {run.progress.map((entry, index) => (
        <p className="workflow-progress" key={index}>
          {entry.text}
        </p>
      ))}
      {run.members.map(member => (
        <MemberTree
          key={member.seq}
          parentId={sessionId}
          {...member}
          depth={depth}
        />
      ))}
    </details>
  )
}

/** One unified view over real session records and linked workflow descendants. */
export function ExecutionPanel({
  sessionId,
  turns,
  runs,
  depth = 0,
}: {
  sessionId: string
  turns: readonly TraceTurn[]
  runs: readonly WorkflowRun[]
  depth?: number
}) {
  const [query, setQuery] = useState('')
  const [status, setStatus] = useState('all')
  const [selected, setSelected] = useState<TraceRequest>()
  const toolIds = new Set(
    turns.flatMap(turn =>
      turn.steps.flatMap(step => step.tools.map(tool => tool.callId)),
    ),
  )
  const runsByCall = new Map<string, WorkflowRun[]>()
  const unlinkedRuns: WorkflowRun[] = []
  for (const run of runs) {
    if (run.callId === undefined || !toolIds.has(run.callId))
      unlinkedRuns.push(run)
    else {
      const linked = runsByCall.get(run.callId) ?? []
      linked.push(run)
      runsByCall.set(run.callId, linked)
    }
  }
  const visible = turns
    .map(turn => ({
      ...turn,
      steps: turn.steps.filter((step) => {
        const match =
          `${step.step} ${step.assistantText ?? ''} ${step.tools.map(tool => tool.name + tool.argsText).join(' ')} ${step.requests.map(request => request.requestId).join(' ')}`
            .toLowerCase()
            .includes(query.toLowerCase())
        return (
          match &&
          (status === 'all' ||
            step.requests.some(
              request => (request.status ?? 'running') === status,
            ) ||
            step.tools.some(tool => status === 'failed' && tool.isError))
        )
      }),
    }))
    .filter(turn => turn.steps.length)
  return (
    <div className="execution-panel">
      {depth === 0 && (
        <div className="execution-toolbar">
          <input
            aria-label={t('search')}
            placeholder={t('search')}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value)
            }}
          />
          <select
            aria-label={t('all')}
            value={status}
            onChange={(event) => {
              setStatus(event.target.value)
            }}
          >
            {(
              ['all', 'running', 'completed', 'failed', 'cancelled'] as const
            ).map(key => (
              <option key={key} value={key}>
                {t(key)}
              </option>
            ))}
          </select>
          <a
            title={t('exportMd')}
            href={`/api/trace/export?sessionId=${encodeURIComponent(sessionId)}&format=md`}
          >
            <Download size={16} />
          </a>
          <a
            title={t('exportJson')}
            href={`/api/trace/export?sessionId=${encodeURIComponent(sessionId)}`}
          >
            <Download size={16} />
          </a>
        </div>
      )}
      {!turns.length && !runs.length && (
        <p className="panel-empty">{t('empty')}</p>
      )}
      {visible.map(turn => (
        <section className="execution-turn" key={turn.turn}>
          <h3>
            {t('turn')} {turn.turn}
            <span>{durationOf(turn.startedAt, turn.endedAt)}</span>
          </h3>
          {turn.steps.map(step => (
            <StepRow
              sessionId={sessionId}
              key={step.step}
              step={step}
              inspect={setSelected}
              runsByCall={runsByCall}
              depth={depth}
            />
          ))}
        </section>
      ))}
      {unlinkedRuns.map(run => (
        <WorkflowNode
          key={run.runId}
          sessionId={sessionId}
          run={run}
          depth={depth}
        />
      ))}
      {selected && (
        <RequestInspector
          key={`${sessionId}:${selected.requestId}`}
          sessionId={sessionId}
          request={selected}
          dismiss={() => {
            setSelected(undefined)
          }}
        />
      )}
    </div>
  )
}
