/**
 * Data Agent frontend: a React+Vite data-analysis chat surface over the dsh
 * web backend. Same-origin unary RPC (`/api/*`) plus the WebSocket mux
 * (`/api/remote.mux`) for live journal events; the trace and workflow panels
 * fold the same session journal the workbench plugins use.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  cancelSession,
  createSession,
  deleteAnalysis,
  executeCommand,
  listSessions,
  prompt,
  readPage,
  RpcError,
} from './protocol/api.ts'
import { Mux } from './protocol/mux.ts'
import type { HistoryRecord, SessionSummary, WireEvent } from './protocol/wire.ts'
import { createJournalFold } from './state/fold.ts'
import { ChatStream, clockOf } from './components/Chat.tsx'
import { reportRequest, type ReportFormat } from './components/ReportActions.tsx'
import { ExecutionPanel } from './components/Panels.tsx'
import {
  PanelRightClose,
  PanelRightOpen,
  Database,
  X,
  Plus,
  ArrowUp,
  Square,
  ArrowUpRight,
  Activity,
  Cpu,
  LoaderCircle,
} from 'lucide-react'
import { t } from './copy.ts'
import { Questions } from './components/Questions.tsx'
import { SourceManager } from './components/SourceManager.tsx'
import { ModelManager } from './components/ModelManager.tsx'
import { ModelControl } from './components/ModelControl.tsx'
import { AnalysisRecord } from './components/AnalysisRecord.tsx'
import { analysisHistory, archiveIds } from './state/analysis-history.ts'
import { sourceRequest } from './protocol/sources.ts'
import type { DataScope, SourceCatalog, SourceInfo } from './protocol/sources.ts'

const SUGGESTIONS = ['overviewTask', 'trendTask', 'reportTask'] as const

/** Relative-time label for one epoch-ms stamp. */
function relativeTime(time: number): string {
  const delta = Date.now() - time
  if (delta < 60_000) return t('now')
  if (delta < 3_600_000) return `${Math.floor(delta / 60_000)} ${t('minutesAgo')}`
  if (delta < 86_400_000) return `${Math.floor(delta / 3_600_000)} ${t('hoursAgo')}`
  return `${Math.floor(delta / 86_400_000)} ${t('daysAgo')}`
}

/** Latest durable model selection or request header, without copying the journal. */
function modelCursor(events: readonly WireEvent[]): number {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index]
    if (event.type === 'request/header' || event.type === 'model/selection') return event.seq
  }
  return -1
}

export function App(): React.JSX.Element {
  const muxRef = useRef<Mux | undefined>(undefined)
  const followCancelRef = useRef<(() => void) | undefined>(undefined)
  const backfillingRef = useRef(new Set<string>())
  const generationRef = useRef(0)
  const sourcesGenerationRef = useRef(0)
  const archiveRevisionRef = useRef(0)
  const deletingRef = useRef<string>()
  const creatingRef = useRef<Promise<string | undefined>>()
  const projectionRef = useRef({ fold: createJournalFold(), count: 0, lastSeq: -1 })
  const chatEndRef = useRef<HTMLDivElement | null>(null)

  const [sessions, setSessions] = useState<SessionSummary[]>([])
  const [archived, setArchived] = useState<string[]>()
  const [deletingId, setDeletingId] = useState<string>()
  const [deletionNotice, setDeletionNotice] = useState<string>()
  const [activeId, setActiveId] = useState<string | undefined>(undefined)
  const [events, setEvents] = useState<WireEvent[]>([])
  const [eventsSessionId, setEventsSessionId] = useState<string>()
  const [databases, setDatabases] = useState<string[]>([])
  const [sourceInfo, setSourceInfo] = useState<SourceInfo[]>([])
  const [managingSources, setManagingSources] = useState(false)
  const [managingModels, setManagingModels] = useState(false)
  const [creatingAnalysis, setCreatingAnalysis] = useState(false)
  const [modelRevision, setModelRevision] = useState(0)
  const [draft, setDraft] = useState('')
  const [rightOpen, setRightOpen] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const [titles, setTitles] = useState<Record<string, string>>({})
  const activeIdRef = useRef(activeId)
  activeIdRef.current = activeId

  const sessionsRef = useRef<SessionSummary[]>([])
  sessionsRef.current = sessions

  /** Merge one page of journal records into the event list, sorted by seq. */
  const mergeEvents = useCallback((incoming: readonly WireEvent[]) => {
    if (incoming.length === 0) return
    setEvents((previous) => {
      const seen = new Set(previous.map(event => event.seq))
      const merged = [...previous]
      for (const event of incoming) {
        if (!seen.has(event.seq)) {
          merged.push(event)
          seen.add(event.seq)
        }
      }
      merged.sort((a, b) => a.seq - b.seq)
      return merged
    })
  }, [])

  /** Backfill older journal pages until exhausted or the guard trips. */
  const backfill = useCallback(
    async (sessionId: string, beforeSeq: number, generation: number) => {
      const key = `${sessionId}:${generation}`
      if (backfillingRef.current.has(key)) return
      backfillingRef.current.add(key)
      try {
        let before = beforeSeq
        while (before > 0 && generation === generationRef.current) {
          const result = await readPage(sessionId, before - 1)
          if (generation !== generationRef.current) break
          mergeEvents(result.records.map((record: HistoryRecord) => record.event))
          if (!result.hasMore || result.records.length === 0) break
          before = Math.min(...result.records.map(record => record.event.seq))
        }
      } catch (cause) {
        if (generation === generationRef.current) setError(`${t('historyFailed')}: ${String(cause)}`)
      } finally {
        backfillingRef.current.delete(key)
      }
    },
    [mergeEvents],
  )

  /** Follow one session's journal: snapshot, live events, backfill. */
  const followSession = useCallback(
    (sessionId: string) => {
      const generation = ++generationRef.current
      followCancelRef.current?.()
      projectionRef.current = { fold: createJournalFold(), count: 0, lastSeq: -1 }
      setEventsSessionId(sessionId)
      setEvents([])
      const mux = muxRef.current
      if (mux === undefined) return
      const { cancel } = mux.open(
        'session/follow',
        { args: { request: { address: { kind: 'session', sessionId } } } },
        {
          onItem: (value) => {
            if (generation !== generationRef.current) return
            const item = value as {
              type: string
              cursor?: number
              records?: HistoryRecord[]
              hasMore?: boolean
              event?: WireEvent
            }
            if (item.type === 'snapshot' && Array.isArray(item.records)) {
              mergeEvents(item.records.map(record => record.event))
              if (item.hasMore === true && item.cursor !== undefined) {
                void backfill(sessionId, item.records[0]?.event.seq ?? 0, generation)
              }
            } else if (item.type === 'event' && item.event !== undefined) {
              mergeEvents([item.event])
            }
          },
          onError: (err) => {
            if (generation === generationRef.current) setError(`${t('streamFailed')}: ${err.message}`)
          },
        },
      )
      followCancelRef.current = cancel
    },
    [backfill, mergeEvents],
  )

  const refreshSessions = useCallback(() => {
    listSessions()
      .then((result) => {
        // Subagent sessions need their parent's address to follow; hide them.
        const roots = result.items.filter(session => session.parentSessionId === undefined)
        setSessions(roots)
      })
      .catch(() => {
        /* offline; retried on the next tick */
      })
  }, [])

  const refreshSources = useCallback(() => {
    const generation = ++sourcesGenerationRef.current
    const target = activeIdRef.current
    void sourceRequest<SourceCatalog>('sources')
      .then(async (catalog) => {
        const scope = target
          ? (
            await sourceRequest<{ scope: DataScope | null }>(
              `scope?sessionId=${encodeURIComponent(target)}`,
            )
          ).scope
          : null
        if (generation !== sourcesGenerationRef.current) return
        setSourceInfo(catalog.sources)
        setDatabases(
          catalog.sources
            .filter(source => !scope || scope.sources.some(item => item.database === source.id))
            .map(source => source.id),
        )
      })
      .catch((cause: unknown) => {
        if (generation === sourcesGenerationRef.current) setError(String(cause))
      })
  }, [activeId])
  useEffect(() => {
    refreshSources()
    return () => {
      sourcesGenerationRef.current++
    }
  }, [refreshSources])

  useEffect(() => {
    const mux = new Mux()
    muxRef.current = mux
    mux.start()
    mux.open('workspace/follow', { args: {} }, {
      onItem: (value) => {
        try {
          const ids = archiveIds(value)
          if (ids) { archiveRevisionRef.current++; setArchived(ids) }
        } catch {
          setError(t('historyVisibilityFailed'))
        }
      },
      onError: () => { setError(t('historyVisibilityFailed')) },
    })
    refreshSessions()
    const timer = setInterval(refreshSessions, 4000)
    return () => {
      clearInterval(timer)
      mux.close()
    }
  }, [refreshSessions])

  const visibleSessions = useMemo(() => analysisHistory(sessions, archived), [sessions, archived])
  useEffect(() => {
    setActiveId(previous => visibleSessions.some(session => session.sessionId === previous) ? previous : visibleSessions[0]?.sessionId)
  }, [visibleSessions])

  // Follow the active session (and recover the stream after reconnects).
  const followRef = useRef(followSession)
  followRef.current = followSession
  useEffect(() => {
    if (activeId === undefined) {
      generationRef.current++
      followCancelRef.current?.()
      setEvents([])
      return
    }
    followRef.current(activeId)
  }, [activeId])

  const view = useMemo(() => {
    let projection = projectionRef.current
    if (
      events.length < projection.count ||
      (projection.count > 0 && events[projection.count - 1]?.seq !== projection.lastSeq)
    ) {
      projection = { fold: createJournalFold(), count: 0, lastSeq: -1 }
      projectionRef.current = projection
    }
    const value = projection.fold.append(events.slice(projection.count))
    projection.count = events.length
    projection.lastSeq = events.at(-1)?.seq ?? -1
    return value
  }, [events])
  const activeSession = sessions.find(session => session.sessionId === activeId)

  const flags = new URLSearchParams(location.search)
  const showChat = !flags.has('quiet') && !flags.has('nochat')
  const showPanels = !flags.has('quiet') && !flags.has('nopanels')

  const createAnalysis = useCallback((): Promise<string | undefined> => {
    if (creatingRef.current) return creatingRef.current
    setCreatingAnalysis(true)
    setError(undefined)
    const pending = createSession()
      .then((result) => {
        refreshSessions()
        setActiveId(result.sessionId)
        return result.sessionId
      })
      .catch((cause: unknown) => {
        setError(`${t('createSessionFailed')}: ${String(cause)}`)
        return undefined
      })
      .finally(() => {
        creatingRef.current = undefined
        setCreatingAnalysis(false)
      })
    creatingRef.current = pending
    return pending
  }, [refreshSessions])

  const newAnalysis = () => {
    void createAnalysis().then((id) => {
      if (!id) return
      setManagingSources(false)
      setManagingModels(false)
    })
  }

  const removeAnalysis = async (sessionId: string): Promise<boolean> => {
    if (deletingRef.current) return false
    deletingRef.current = sessionId
    setDeletingId(sessionId)
    setDeletionNotice(undefined)
    setError(undefined)
    const revision = archiveRevisionRef.current
    try {
      const result = await deleteAnalysis(sessionId)
      // A newer archive stream update outranks a delayed unary response.
      if (revision === archiveRevisionRef.current) {
        archiveRevisionRef.current++
        setArchived(result.archivedSessionIds)
      }
      if (activeIdRef.current === sessionId) {
        setManagingSources(false)
        setManagingModels(false)
        setDraft('')
      }
      setDeletionNotice(t('analysisDeleted'))
      return true
    } catch (cause) {
      setDeletionNotice(cause instanceof RpcError && cause.code === 'workspace/session-active'
        ? t('stopBeforeDelete') : t('deleteAnalysisFailed'))
      return false
    } finally {
      deletingRef.current = undefined
      setDeletingId(undefined)
    }
  }

  const openSources = () => {
    setManagingModels(false)
    if (activeId) {
      setManagingSources(true)
      return
    }
    void createAnalysis().then((id) => {
      if (id) setManagingSources(true)
    })
  }

  const send = useCallback(
    (text: string) => {
      const trimmed = text.trim()
      if (trimmed.length === 0) return
      const target = activeId
      if (target === undefined) {
        setError(t('createSessionFirst'))
        return
      }
      prompt(target, trimmed)
        .then(() => {
          setDraft('')
        })
        .catch((cause: unknown) => {
          setError(`${t('sendFailed')}: ${String(cause)}`)
        })
    },
    [activeId],
  )

  const selectDatabase = useCallback(
    async (name: string) => {
      setError(undefined)
      const target = activeIdRef.current ?? await createAnalysis()
      if (!target) return
      // Route through the host command system so the selection is durably
      // logged (`command/run`) exactly like a typed `/db` line.
      try {
        await executeCommand(target, `/db ${name || 'clear'}`)
      } catch (cause) {
        setError(`${t('chooseSourceFailed')}: ${String(cause)}`)
      }
    },
    [createAnalysis],
  )

  const generateReport = async (turn: number, format: ReportFormat) => {
    if (!activeId || activeId !== eventsSessionId) throw new Error(t('createSessionFirst'))
    const response = await prompt(activeId, reportRequest(turn, format))
    if (!response.accepted) throw new Error(t('sendFailed'))
  }

  // Keep the transcript pinned to the latest entry (instant: smooth scrolling
  // keeps the compositor unsettled and starves screenshot-style captures).
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ block: 'end' })
  }, [view.chat.length, view.running])

  const running = view.running || activeSession?.running === true
  const modelEventSeq = activeId === eventsSessionId
    ? modelCursor(events)
    : -1
  const currentQuestion =
    activeId === eventsSessionId ? view.chat.find(entry => entry.kind === 'user') : undefined
  useEffect(() => {
    if (activeId && currentQuestion?.kind === 'user') {
      const title = currentQuestion.text.replace(/\s+/gu, ' ').slice(0, 80)
      setTitles(previous => (previous[activeId] === title ? previous : { ...previous, [activeId]: title }))
    }
  }, [activeId, currentQuestion])

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true" />{' '}
          <span>
            Data
            <br />
            Agent
          </span>
        </div>
        <button type="button" className="new-btn" onClick={newAnalysis} disabled={creatingAnalysis} aria-busy={creatingAnalysis}>
          {creatingAnalysis ? <LoaderCircle className="spin" size={16} /> : <Plus size={16} />}
          {t('newAnalysis')}
        </button>
        <div className="side-label">
          <span>{t('sessions')}</span>
          <span>{archived ? String(visibleSessions.length).padStart(2, '0') : '--'}</span>
        </div>
        <div className="session-list">
          {!archived ? <div className="session-loading" aria-label={t('loading')}><LoaderCircle className="spin" size={20} /></div>
            : visibleSessions.length === 0 && <p className="side-empty">{t('noSessions')}</p>}
          {visibleSessions.map(session => (
            <AnalysisRecord key={session.sessionId} id={session.sessionId}
              title={titles[session.sessionId] ?? (session.blank ? t('newSession') : `${t('session')} ${session.sessionId.slice(-6)}`)}
              time={relativeTime(session.updatedAt)} active={session.sessionId === activeId}
              running={session.running || (session.sessionId === activeId && eventsSessionId === activeId && view.running)}
              busy={deletingId === session.sessionId} disabled={deletingId !== undefined}
              remove={() => removeAnalysis(session.sessionId)}
              select={() => {
                setActiveId(session.sessionId)
                setManagingSources(false)
                setManagingModels(false)
              }}
            />
          ))}
        </div>
        <div className="side-foot">
          <button className="manage-sources-button" onClick={openSources} disabled={creatingAnalysis}>
            <Database size={15} />
            {t('manageSources')}
          </button>
          <button className="manage-sources-button" onClick={() => { setManagingModels(true); setManagingSources(false) }}>
            <Cpu size={15} />{t('manageModels')}
          </button>
        </div>
      </aside>

      {deletionNotice && <div className="analysis-toast" role="status">
        <span>{deletionNotice}</span>
        <button type="button" aria-label={t('close')} title={t('close')} onClick={() => { setDeletionNotice(undefined) }}><X size={15} /></button>
      </div>}

      <main className="main">
        <header className="topbar" hidden={managingSources || managingModels}>
          <div className="top-title">{t('workspace')}</div>
          <label className="db-picker">
            <Database size={16} />
            <select
              aria-label={t('chooseSource')}
              disabled={creatingAnalysis}
              value={view.selectedDb ?? ''}
              onChange={(event) => {
                void selectDatabase(event.target.value)
              }}
            >
              <option value="">{t('chooseSource')}</option>
              {databases.map(name => (
                <option key={name} value={name}>
                  {sourceInfo.find(source => source.id === name)?.name ?? name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="panel-toggle"
            title={t('execution')}
            onClick={() => {
              setRightOpen(!rightOpen)
            }}
          >
            {rightOpen ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
          </button>
        </header>

        {managingModels ? (
          <ModelManager close={() =>{  setManagingModels(false) }} changed={() =>{  setModelRevision(value => value + 1) }} />
        ) : managingSources && activeId ? (
          <SourceManager
            key={activeId}
            sessionId={activeId}
            running={running}
            changed={refreshSources}
            close={() => {
              setManagingSources(false)
            }}
          />
        ) : (
          <div className="chat-scroll">
            {!showChat ? (
              <div className="workspace-empty">
                <h1>{t('transcriptDisabled')}</h1>
              </div>
            ) : activeId !== eventsSessionId || !view.chat.some(entry => entry.kind !== 'command') ? (
              <div className="workspace-empty">
                <h1>
                  Data Agent
                  <span className="workspace-title-mark" aria-hidden="true" />
                </h1>
                <section className="source-section">
                  <h2>
                    {t('sources')}
                    <span>{String(databases.length).padStart(2, '0')}</span>
                  </h2>
                  <div className="source-columns">
                    <span>{t('sourceName')}</span>
                    <span>{t('sourceType')}</span>
                  </div>
                  {databases.map((name, index) => (
                    <button
                      key={name}
                      className="source-row"
                      disabled={creatingAnalysis}
                      onClick={() => {
                        void selectDatabase(name)
                      }}
                    >
                      <span className="source-number">{String(index + 1).padStart(2, '0')}</span>
                      <Database size={16} />
                      <span className="source-name">
                        {sourceInfo.find(source => source.id === name)?.name ?? name}
                      </span>
                      <span className="source-type">
                        {/\.(db|sqlite|sqlite3)$/iu.test(name) ? 'SQLite' : 'MySQL'}
                      </span>
                      <ArrowUpRight size={16} />
                    </button>
                  ))}
                  {!databases.length && <p className="side-empty">{t('noSources')}</p>}
                </section>
                <div className="task-list">
                  <h2>{t('suggestions')}</h2>
                  {SUGGESTIONS.map(suggestion => (
                    <button
                      key={suggestion}
                      type="button"
                      className="task-row"
                      onClick={() => {
                        setDraft(t(suggestion))
                      }}
                    >
                      <span>{t(suggestion)}</span>
                      <ArrowUpRight size={16} />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <ChatStream key={activeId} entries={view.chat} running={running}
                completedTurns={view.trace.filter(turn => turn.endedAt !== undefined
                  && (turn.reason === 'completed' || turn.reason === 'stop')).map(turn => turn.turn)}
                generateReport={generateReport} />
            )}
            <div ref={chatEndRef} />
          </div>
        )}

        {error !== undefined && (
          <div className="error-bar">
            {error}
            <button
              type="button"
              onClick={() => {
                setError(undefined)
              }}
            >
              <X size={16} />
            </button>
          </div>
        )}

        <footer className="composer" hidden={managingSources || managingModels}>
          {activeId && <Questions key={activeId} sessionId={activeId} />}
          <textarea
            value={draft}
            placeholder={t('questionPlaceholder')}
            onChange={(event) => {
              setDraft(event.target.value)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && !event.shiftKey) {
                event.preventDefault()
                send(draft)
              }
            }}
          />
          <ModelControl sessionId={activeId} eventSeq={modelEventSeq} revision={modelRevision} running={running}
            manage={() => { setManagingModels(true); setManagingSources(false) }} />
          <div className="composer-row">
            <span className="composer-hint">
              <Database size={13} />
              {view.selectedDb !== undefined
                ? (sourceInfo.find(source => source.id === view.selectedDb)?.name ?? view.selectedDb)
                : t('noSource')}
            </span>
            {running ? (
              <button
                type="button"
                className="stop-btn"
                title={t('stop')}
                aria-label={t('stop')}
                onClick={() => activeId !== undefined && void cancelSession(activeId)}
              >
                <Square size={16} />
              </button>
            ) : (
              <button
                type="button"
                className="send-btn"
                title={t('send')}
                aria-label={t('send')}
                disabled={draft.trim().length === 0}
                onClick={() => {
                  send(draft)
                }}
              >
                <ArrowUp size={18} />
              </button>
            )}
          </div>
        </footer>
      </main>

      {rightOpen && showPanels && !managingSources && !managingModels && (
        <aside className="rightbar">
          <div className="execution-heading">
            <span>
              <Activity size={16} />
              {t('execution')}
            </span>
            <button
              title={t('close')}
              onClick={() => {
                setRightOpen(false)
              }}
            >
              <X size={16} />
            </button>
          </div>
          <div className="right-body">
            {activeId && (
              <ExecutionPanel key={activeId} sessionId={activeId} turns={view.trace} runs={view.workflows} />
            )}
          </div>
          {activeId !== undefined && (
            <div className="right-foot">
              {t('recentActivity')}{' '}
              {clockOf(sessions.find(s => s.sessionId === activeId)?.updatedAt ?? Date.now())}
            </div>
          )}
        </aside>
      )}
    </div>
  )
}
