/**
 * Transcript rendering: user/assistant messages (markdown), structured tool
 * cards for the database tools (SQL + result table + chart toggle), command
 * chips for `/db`, and the running indicator.
 */
import { useMemo, useState } from 'react'
import type { ChatEntry, ToolCard } from '../state/fold.ts'
import { Markdown } from './Markdown.tsx'
import { ArtifactLinks } from './Artifacts.tsx'
import { ReportActions, type ReportFormat } from './ReportActions.tsx'
import { answerMarkdown } from '../state/answer.ts'
import { t } from '../copy.ts'
import {
  Database,
  FileText,
  Check,
  TriangleAlert,
  Loader2,
  Wrench,
  ChevronDown,
  ChevronRight,
  Brain,
  Terminal,
} from 'lucide-react'

const toolLabels: Partial<Record<string, Parameters<typeof t>[0]>> = {
  sql: 'query',
  report: 'report',
  benchmark: 'benchmark',
  finish: 'submit',
  ask: 'clarification',
  read: 'readDocument',
  query_database: 'query',
  read_document: 'readDocument',
  list_sources: 'discover',
  list_databases: 'discover',
  search_documents: 'searchDocuments',
  import_dataset: 'importDataset',
  analyze_data: 'analyze',
  render_chart: 'renderChart',
  generate_report: 'report',
  submit_analysis: 'submit',
}

/** Human clock label for one epoch-ms timestamp. */
export function clockOf(time: number): string {
  const date = new Date(time)
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

/** Duration label between two epoch-ms stamps. */
export function durationOf(start?: number, end?: number): string {
  if (start === undefined || end === undefined) return ''
  return `${((end - start) / 1000).toFixed(1)}s`
}

interface QueryMeta {
  readonly database?: string
  readonly rowCount?: number
  readonly truncated?: boolean
  readonly columns?: readonly string[]
  readonly rows?: readonly Record<string, unknown>[]
}

/** Narrow one tool card's presentation meta to the query shape. */
function queryMetaOf(card: ToolCard): QueryMeta | undefined {
  const meta = card.meta
  if (meta === undefined || !Array.isArray(meta.columns) || !Array.isArray(meta.rows)) return undefined
  return {
    database: typeof meta.database === 'string' ? meta.database : undefined,
    rowCount: typeof meta.rowCount === 'number' ? meta.rowCount : undefined,
    truncated: meta.truncated === true,
    columns: meta.columns as readonly string[],
    rows: meta.rows as readonly Record<string, unknown>[],
  }
}

/** Coerce one cell to a number; MySQL reports DECIMAL/SUM as strings. */
function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value
  if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value))) return Number(value)
  return null
}

function cellText(value: unknown): string {
  return typeof value === 'string' ? value : value === undefined ? '' : JSON.stringify(value)
}

/** Pick the first column whose values are all numeric. */
function numericColumn(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): string | undefined {
  return columns.find(column => rows.every(row => asNumber(row[column]) !== null))
}

/** Pick the first column whose values are not all numeric (chart labels). */
function labelColumn(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): string | undefined {
  return columns.find(column => rows.some(row => asNumber(row[column]) === null))
}

/** Hand-rolled SVG bar chart over the query result. */
function ResultChart({ meta }: { meta: QueryMeta }) {
  const columns = meta.columns ?? []
  const rows = (meta.rows ?? []).slice(0, 12)
  const label = labelColumn(columns, rows) ?? columns[0]
  const value = numericColumn(columns, rows)
  if (value === undefined || rows.length === 0) {
    return <p className="chart-empty">{t('chartEmpty')}</p>
  }
  const width = 560
  const height = 220
  const pad = { left: 8, bottom: 44, top: 12 }
  const values = rows.map(row => asNumber(row[value]) ?? 0)
  const max = Math.max(...values, 1)
  const barArea = width - pad.left * 2
  const barWidth = Math.max(8, barArea / rows.length - 10)
  return (
    <div className="chart-wrap">
      <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={t('chart')}>
        {rows.map((row, i) => {
          const barHeight = Math.round((height - pad.bottom - pad.top) * (values[i] / max))
          const x = pad.left + i * (barArea / rows.length) + 5
          const y = height - pad.bottom - barHeight
          const labelText = cellText(row[label] ?? '')
          const shown = labelText.length > 8 ? `${labelText.slice(0, 8)}…` : labelText
          return (
            <g key={i}>
              <rect x={x} y={y} width={barWidth} height={barHeight} rx="3" className="chart-bar">
                <title>{`${labelText}: ${values[i]}`}</title>
              </rect>
              <text
                x={x + barWidth / 2}
                y={height - pad.bottom + 16}
                textAnchor="middle"
                className="chart-label"
              >
                {shown}
              </text>
              <text x={x + barWidth / 2} y={y - 4} textAnchor="middle" className="chart-value">
                {values[i]}
              </text>
            </g>
          )
        })}
      </svg>
      <p className="chart-caption">{`${label} / ${value} · ${t('previewOnly')} ${rows.length} ${t('rows')}`}</p>
    </div>
  )
}

/** Rendered rows of one query result, capped for display. */
function ResultTable({ meta }: { meta: QueryMeta }) {
  const rows = meta.rows ?? []
  return (
    <div className="result-table-wrap">
      <table className="result-table">
        <thead>
          <tr>
            {(meta.columns ?? []).map(column => (
              <th key={column}>{column}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, r) => (
            <tr key={r}>
              {(meta.columns ?? []).map((column) => {
                const cell = row[column]
                return <td key={column}>{cell === null || cell === undefined ? '—' : cellText(cell)}</td>
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

/** SQL results, delivered reports and explicit submissions with their saved metadata. */
function ToolCardView({ card }: { card: ToolCard }) {
  const [open, setOpen] = useState(
    (card.name === 'sql' || card.name === 'query_database') || (card.name === 'report' || card.name === 'generate_report') || (card.name === 'finish' || card.name === 'submit_analysis'),
  )
  const [view, setView] = useState<'table' | 'chart'>('table')
  const meta = queryMetaOf(card)
  const running = card.endedAt === undefined && !card.isError
  const sql = typeof card.args.sql === 'string' ? card.args.sql : undefined
  const database = typeof card.args.database === 'string' ? card.args.database : undefined
  const databases = Array.isArray(card.meta?.databases)
    ? (card.meta.databases as readonly string[])
    : undefined
  const label = toolLabels[card.name]
  return (
    <div className={`tool-card${card.isError === true ? ' tool-error' : ''}`}>
      <button
        type="button"
        className="tool-head"
        aria-expanded={open}
        onClick={() => {
          setOpen(!open)
        }}
      >
        <span className="tool-glyph">
          {running ? (
            <Loader2 size={15} className="spin" />
          ) : card.isError === true ? (
            <TriangleAlert size={15} />
          ) : (card.name === 'sql' || card.name === 'query_database') ? (
            <Database size={15} />
          ) : card.name === 'read_document' || (card.name === 'report' || card.name === 'generate_report') ? (
            <FileText size={15} />
          ) : (
            <Wrench size={15} />
          )}
        </span>
        <span className="tool-title">
          {label === undefined ? card.name : t(label)}
          {(card.name === 'sql' || card.name === 'query_database') && database && <span className="tool-source">{database}</span>}
        </span>
        <span className="tool-meta">
          {durationOf(card.startedAt, card.endedAt)}
          {meta?.rowCount !== undefined ? ` · ${meta.rowCount} ${t('rows')}` : ''}
          {meta?.truncated === true ? ` · ${t('previewOnly')}` : ''}
        </span>
        <span className="tool-caret">{open ? <ChevronDown size={14} /> : <ChevronRight size={14} />}</span>
      </button>
      {open && (
        <div className="tool-body">
          <ArtifactLinks value={card.meta} />
          {(card.name === 'finish' || card.name === 'submit_analysis') && typeof card.meta?.answer === 'string' && (
            <Markdown text={answerMarkdown(card.meta.answer)} />
          )}
          {sql !== undefined && (
            <pre className="sql-code">
              <code>{sql}</code>
            </pre>
          )}
          {card.isError === true && <p className="tool-error-text">{card.resultText ?? t('failedTool')}</p>}
          {meta !== undefined && !card.isError && (
            <>
              <div className="result-toolbar">
                <span className="result-stat">
                  <Check size={13} />
                  {`${meta.rowCount ?? meta.rows?.length ?? 0} ${t('rows')} · ${meta.database ?? ''}`}
                </span>
                {numericColumn(meta.columns ?? [], meta.rows ?? []) !== undefined &&
                  (meta.rows?.length ?? 0) > 1 && (
                  <span className="view-toggle">
                    <button
                      type="button"
                      className={view === 'table' ? 'on' : ''}
                      onClick={() => {
                        setView('table')
                      }}
                    >
                      {t('table')}
                    </button>
                    <button
                      type="button"
                      className={view === 'chart' ? 'on' : ''}
                      onClick={() => {
                        setView('chart')
                      }}
                    >
                      {t('chart')}
                    </button>
                  </span>
                )}
              </div>
              {view === 'table' ? <ResultTable meta={meta} /> : <ResultChart meta={meta} />}
            </>
          )}
          {databases !== undefined && (
            <div className="db-chips">
              {databases.map(name => (
                <span key={name} className="db-chip">
                  {name}
                </span>
              ))}
            </div>
          )}
          {card.name === 'read_document' && typeof card.meta?.markdown === 'string' && !card.isError && (
            <Markdown text={card.meta.markdown} />
          )}
          {card.resultText !== undefined &&
            card.isError !== true &&
            card.name !== 'read_document' &&
            meta === undefined && (
            <details className="tool-observation">
              <summary>{t('result')}</summary>
              <pre className="tool-raw">{card.resultText}</pre>
            </details>
          )}
        </div>
      )}
    </div>
  )
}

/** Reasoning (thinking) collapsible above the assistant text. */
function Reasoning({ text }: { text: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="reasoning">
      <button
        type="button"
        onClick={() => {
          setOpen(!open)
        }}
      >
        <Brain size={13} />
        {t('reasoning')}
        <ChevronDown size={12} />
      </button>
      {open && <div className="reasoning-body">{text}</div>}
    </div>
  )
}

function AnswerBody({ text, plain }: { text: string; plain: boolean }) {
  const displayed = useMemo(() => answerMarkdown(text), [text])
  return plain ? <p className="md-p">{displayed}</p> : <Markdown text={displayed} />
}

/** The whole transcript for one session. */
export function ChatStream({
  entries,
  running,
  plain,
  completedTurns = [],
  generateReport,
}: {
  entries: readonly ChatEntry[]
  running: boolean
  plain?: boolean
  completedTurns?: readonly number[]
  generateReport?: (turn: number, format: ReportFormat) => Promise<unknown>
}) {
  const finalAnswers = new Map<number, string>()
  for (const entry of entries) {
    if (entry.kind === 'assistant' && entry.text.trim()) finalAnswers.set(entry.turn, entry.key)
  }
  return (
    <div className="chat-stream">
      {entries.map((entry) => {
        switch (entry.kind) {
          case 'user':
            return (
              <div key={entry.key} className="msg-user">
                <div className="bubble-user">{entry.text}</div>
                <div className="msg-time">{clockOf(entry.time)}</div>
              </div>
            )
          case 'assistant':
            if (!entry.text.trim()) return null
            return (
              <div key={entry.key} className="msg-assistant">
                <div className="assistant-avatar">DA</div>
                <div className="assistant-main">
                  {entry.reasoning !== undefined && <Reasoning text={entry.reasoning} />}
                  <AnswerBody text={entry.text} plain={plain === true} />
                  {generateReport && completedTurns.includes(entry.turn) && finalAnswers.get(entry.turn) === entry.key && (
                    <ReportActions turn={entry.turn} disabled={running} generate={generateReport} />
                  )}
                  <div className="msg-foot">
                    <span className="msg-time">{clockOf(entry.time)}</span>
                    {entry.usage?.input !== undefined && (
                      <span className="msg-usage">{`${t('input')} ${entry.usage.input}${entry.usage.output !== undefined ? ` · ${t('outputTokens')} ${entry.usage.output}` : ''} tok`}</span>
                    )}
                  </div>
                </div>
              </div>
            )
          case 'tool':
            return <ToolCardView key={entry.key} card={entry.card} />
          case 'command':
            return (
              <div key={entry.key} className={`cmd-chip${entry.done && !entry.done.ok ? ' cmd-error' : ''}`}>
                <span className="cmd-name">
                  {entry.name === 'data_scope' ? <Database size={14} /> : <Terminal size={14} />}
                  {entry.name === 'data_scope' ? t('applyScope') : entry.name}
                </span>
                {entry.name !== 'data_scope' && entry.args !== undefined && (
                  <span className="cmd-args">{entry.args}</span>
                )}
                <span className="cmd-result">
                  {entry.name === 'data_scope' && entry.done?.ok
                    ? t('scopeSaved')
                    : (entry.done?.text ?? (entry.done === undefined ? t('commandRunning') : ''))}
                </span>
              </div>
            )
          default:
            return null
        }
      })}
      {running && (
        <div className="thinking-row">
          <Loader2 size={14} className="spin" />
          {t('analyzing')}
        </div>
      )}
    </div>
  )
}
