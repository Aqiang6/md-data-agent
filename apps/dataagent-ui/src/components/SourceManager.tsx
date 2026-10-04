/** Desktop source connections, session database selection and Markdown schema workspace. */
import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ArrowLeft,
  Check,
  Database,
  FileText,
  LoaderCircle,
  Plug,
  Plus,
  RefreshCw,
  Trash2,
} from 'lucide-react'
import { t } from '../copy.ts'
import { executeCommand } from '../protocol/api.ts'
import { sourceRequest } from '../protocol/sources.ts'
import type {
  DatabaseMetadata,
  DataScope,
  SourceCatalog,
  SourceInfo,
} from '../protocol/sources.ts'
import { KnowledgeLibrary } from './KnowledgeLibrary.tsx'

/** Source workspace bound to one analysis session; credentials remain in form memory only. */
export function SourceManager({
  sessionId,
  close,
  changed,
  running,
}: {
  sessionId: string
  close: () => void
  changed: () => void
  running: boolean
}) {
  const [catalog, setCatalog] = useState<SourceCatalog>({ sources: [], connections: [], databases: [] })
  const [scope, setScope] = useState<DataScope>({ version: 2, sources: [], defaultDatabase: null })
  const [active, setActive] = useState<SourceInfo>()
  const activeId = useRef<string>()
  activeId.current = active?.id
  const [schema, setSchema] = useState<DatabaseMetadata>()
  const [tab, setTab] = useState<'tables' | 'schema' | 'business'>('tables')
  const [connecting, setConnecting] = useState(false)
  const [form, setForm] = useState({
    label: '',
    host: 'localhost',
    port: 3306,
    username: '',
    password: '',
    credentialEnv: '',
    tls: false,
  })
  const [discovered, setDiscovered] = useState<string[]>([])
  const [selected, setSelected] = useState<string[]>([])
  const [tested, setTested] = useState(false)
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [creating, setCreating] = useState('')
  const [newName, setNewName] = useState('')
  const refresh = useCallback(async () => {
    const next = await sourceRequest<SourceCatalog>('sources')
    const current = await sourceRequest<{ scope: DataScope | null }>(
      `scope?sessionId=${encodeURIComponent(sessionId)}`,
    )
    setCatalog(next)
    setScope(
      current.scope ?? {
        version: 2,
        sources: next.sources.map(source => ({ database: source.id })),
        defaultDatabase: null,
      },
    )
    setActive(previous => next.sources.find(source => source.id === previous?.id) ?? next.sources[0])
  }, [sessionId])
  useEffect(() => {
    let live = true
    void refresh()
      .catch((cause: unknown) => {
        if (live) setError(String(cause))
      })
    return () => {
      live = false
    }
  }, [refresh])
  useEffect(() => {
    if (!active) return
    let live = true
    setSchema(undefined)
    setFilter('')
    void sourceRequest<DatabaseMetadata>(
      `tables?sessionId=${encodeURIComponent(sessionId)}&database=${encodeURIComponent(active.id)}&full=1`,
    )
      .then((value) => {
        if (!live) return
        setSchema(value)
      })
      .catch((cause: unknown) => {
        if (live) setError(String(cause))
      })
    return () => {
      live = false
    }
  }, [active, sessionId])
  const operation = async (run: () => Promise<void>): Promise<void> => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await run()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(false)
    }
  }
  const connectionForm = () => ({
    ...form,
    ...(form.credentialEnv ? { credentialEnv: form.credentialEnv } : { credentialEnv: undefined }),
    databases: selected,
  })
  const edit = (patch: Partial<typeof form>) => {
    setForm(previous => ({ ...previous, ...patch }))
    setTested(false)
    setDiscovered([])
    setSelected([])
  }
  const toggleSource = (source: SourceInfo, checked: boolean) => {
    setScope(previous => ({
      ...previous,
      sources: checked
        ? [
          ...previous.sources,
          { database: source.id },
        ]
        : previous.sources.filter(item => item.database !== source.id),
      defaultDatabase: previous.defaultDatabase === source.id && !checked ? null : previous.defaultDatabase,
    }))
  }
  const tables =
    schema?.tables.filter(table => table.name.toLowerCase().includes(filter.toLowerCase())) ?? []
  const apply = () =>
    operation(async () => {
      const next = scope
      await executeCommand(sessionId, `/data_scope ${JSON.stringify(next)}`)
      const saved = await sourceRequest<{ scope: DataScope | null }>(
        `scope?sessionId=${encodeURIComponent(sessionId)}`,
      )
      if (JSON.stringify(saved.scope) !== JSON.stringify(next)) throw new Error(t('scopeNotSaved'))
      setScope(next)
      setNotice(t('scopeSaved'))
      changed()
    })
  return (
    <section className="source-manager">
      <header className="manager-heading">
        <button
          className="panel-toggle"
          aria-label={t('backAnalysis')}
          title={t('backAnalysis')}
          onClick={close}
        >
          <ArrowLeft size={18} />
        </button>
        <h1>{t('manageSources')}</h1>
        <button className="manager-command" disabled={busy || running} onClick={() => void apply()}>
          <Check size={16} />
          {t('applyScope')}
        </button>
      </header>
      <div className="manager-notice" role="status">
        {error ? (
          <span className="manager-error">{error}</span>
        ) : (
          notice || (running ? t('stopBeforeScope') : '')
        )}
        {busy && <LoaderCircle className="spin" size={16} />}
      </div>
      <div className="manager-grid">
        <nav className="manager-sources">
          <div className="manager-section-title">
            <h2>{t('sources')}</h2>
            <button
              title={t('addConnection')}
              aria-label={t('addConnection')}
              onClick={() => {
                setConnecting(!connecting)
                setError('')
              }}
            >
              <Plus size={16} />
            </button>
          </div>
          {catalog.sources.map(source => (
            <div className={`manager-source${active?.id === source.id ? ' active' : ''}`} key={source.id}>
              <input
                type="checkbox"
                aria-label={`${t('enabledDatabase')} ${source.name}`}
                checked={scope.sources.some(item => item.database === source.id)}
                disabled={busy || running}
                onChange={(event) => {
                  toggleSource(source, event.target.checked)
                }}
              />
              <button
                onClick={() => {
                  setActive(source)
                  setConnecting(false)
                }}
              >
                <Database size={15} />
                <span>
                  {source.name}
                  <small>{source.connectionLabel ?? source.kind}</small>
                </span>
              </button>
            </div>
          ))}
          <div className="manager-section-title connections-title">
            <h2>{t('connections')}</h2>
          </div>
          {catalog.connections.map(connection => (
            <div className="manager-connection" key={connection.id}>
              <div>
                <span>{connection.label}</span>
                <small>
                  {connection.host}:{connection.port}
                </small>
              </div>
              <button
                title={t('createDatabase')}
                aria-label={`${t('createDatabase')} ${connection.label}`}
                disabled={busy}
                onClick={() => {
                  setCreating(connection.id)
                  setNewName('')
                }}
              >
                <Plus size={15} />
              </button>
              <button
                title={t('removeConnection')}
                aria-label={`${t('removeConnection')} ${connection.label}`}
                disabled={busy}
                onClick={() =>
                  void operation(async () => {
                    await sourceRequest('connections/remove', { id: connection.id })
                    await refresh()
                    changed()
                    setNotice(t('connectionRemoved'))
                  })
                }
              >
                <Trash2 size={15} />
              </button>
            </div>
          ))}
        </nav>
        <div className="manager-detail">
          {connecting ? (
            <form
              className="connection-form"
              onSubmit={(event) => {
                event.preventDefault()
                void operation(async () => {
                  const result = await sourceRequest<{ databases: string[] }>(
                    'connections/test',
                    connectionForm(),
                  )
                  setDiscovered(result.databases)
                  setTested(true)
                  setNotice(t('connectionTested'))
                })
              }}
            >
              <h2>{t('addConnection')}</h2>
              <label>
                {t('connectionLabel')}
                <input
                  required
                  value={form.label}
                  onChange={(event) => {
                    edit({ label: event.target.value })
                  }}
                />
              </label>
              <div className="connection-fields">
                <label>
                  {t('host')}
                  <input
                    disabled={!!form.credentialEnv}
                    value={form.host}
                    onChange={(event) => {
                      edit({ host: event.target.value })
                    }}
                  />
                </label>
                <label>
                  {t('port')}
                  <input
                    type="number"
                    min="1"
                    max="65535"
                    disabled={!!form.credentialEnv}
                    value={form.port}
                    onChange={(event) => {
                      edit({ port: Number(event.target.value) })
                    }}
                  />
                </label>
              </div>
              <div className="connection-fields">
                <label>
                  {t('username')}
                  <input
                    autoComplete="off"
                    disabled={!!form.credentialEnv}
                    value={form.username}
                    onChange={(event) => {
                      edit({ username: event.target.value })
                    }}
                  />
                </label>
                <label>
                  {t('password')}
                  <input
                    type="password"
                    autoComplete="new-password"
                    disabled={!!form.credentialEnv}
                    value={form.password}
                    onChange={(event) => {
                      edit({ password: event.target.value })
                    }}
                  />
                </label>
              </div>
              <label>
                {t('credentialReference')}
                <input
                  autoComplete="off"
                  value={form.credentialEnv}
                  onChange={(event) => {
                    edit({ credentialEnv: event.target.value, password: '' })
                  }}
                />
              </label>
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  checked={form.tls}
                  onChange={(event) => {
                    edit({ tls: event.target.checked })
                  }}
                />
                {t('tls')}
              </label>
              <div className="connection-actions">
                <button className="manager-command" type="submit" disabled={busy}>
                  <Plug size={16} />
                  {t('testConnection')}
                </button>
                <button
                  className="manager-command"
                  type="button"
                  disabled={busy || !tested || !selected.length}
                  onClick={() =>
                    void operation(async () => {
                      await sourceRequest('connections/save', connectionForm())
                      setForm(previous => ({ ...previous, password: '' }))
                      setConnecting(false)
                      await refresh()
                      changed()
                      setNotice(t('connectionSaved'))
                    })
                  }
                >
                  <Check size={16} />
                  {t('saveConnection')}
                </button>
              </div>
              {tested && (
                <fieldset className="discovered-databases">
                  <legend>{t('accessibleDatabases')}</legend>
                  {discovered.map(name => (
                    <label className="checkbox-label" key={name}>
                      <input
                        type="checkbox"
                        checked={selected.includes(name)}
                        onChange={(event) => {
                          setSelected(previous =>
                            event.target.checked
                              ? [...previous, name]
                              : previous.filter(item => item !== name),
                          )
                        }}
                      />
                      {name}
                    </label>
                  ))}
                </fieldset>
              )}
            </form>
          ) : (
            <>
              {creating && (
                <form
                  className="create-database-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void operation(async () => {
                      await sourceRequest('databases/create', { connectionId: creating, name: newName })
                      setCreating('')
                      await refresh()
                      changed()
                      setNotice(t('databaseCreated'))
                    })
                  }}
                >
                  <label>
                    {t('newDatabaseName')}
                    <input
                      required
                      pattern="[A-Za-z][A-Za-z0-9_-]{0,63}"
                      value={newName}
                      onChange={(event) => {
                        setNewName(event.target.value)
                      }}
                    />
                  </label>
                  <button className="manager-command" disabled={busy}>
                    <Plus size={16} />
                    {t('createDatabase')}
                  </button>
                  <button
                    type="button"
                    className="manager-command"
                    onClick={() => {
                      setCreating('')
                    }}
                  >
                    {t('close')}
                  </button>
                </form>
              )}
              {active && (
                <>
                  <div className="schema-heading">
                    <div>
                      <h2>{active.name}</h2>
                      <span>{active.connectionLabel ?? active.kind}</span>
                    </div>
                    {tab === 'tables' && <button
                      title={t('refreshSchema')}
                      aria-label={t('refreshSchema')}
                      disabled={busy}
                      onClick={() =>
                        void operation(async () => {
                          const refreshed = await sourceRequest<DatabaseMetadata>(
                            `tables?sessionId=${encodeURIComponent(sessionId)}&database=${encodeURIComponent(active.id)}&full=1`,
                          )
                          if (activeId.current === active.id) setSchema(refreshed)
                        })
                      }
                    >
                      <RefreshCw size={16} />
                    </button>}
                  </div>
                  <div className="manager-tabs">
                    <button
                      className={tab === 'tables' ? 'active' : ''}
                      onClick={() => {
                        setTab('tables')
                      }}
                    >
                      <Database size={15} />
                      {t('databaseTables')}
                    </button>
                    <button
                      className={tab === 'schema' ? 'active' : ''}
                      onClick={() => {
                        setTab('schema')
                      }}
                    >
                      <FileText size={15} />
                      {t('schemaLibrary')}
                    </button>
                    <button
                      className={tab === 'business' ? 'active' : ''}
                      onClick={() => {
                        setTab('business')
                      }}
                    >
                      <FileText size={15} />
                      {t('businessLibrary')}
                    </button>
                  </div>
                  {tab === 'tables' ? (
                    <>
                      <div className="table-toolbar">
                        <input
                          aria-label={t('filterTables')}
                          placeholder={t('filterTables')}
                          value={filter}
                          onChange={(event) => {
                            setFilter(event.target.value)
                          }}
                        />
                        <span>{t('allTablesEnabled')}</span>
                      </div>
                      <div className="table-list">
                        {!schema ? (
                          <LoaderCircle className="spin" size={20} />
                        ) : tables.length ? (
                          tables.map(table => (
                            <div className="table-summary" key={table.name}>
                              <span>{table.name}</span>
                              <small>
                                {table.columns.length} {t('fields')}
                              </small>
                            </div>
                          ))
                        ) : (
                          <p>{t('noTables')}</p>
                        )}
                      </div>
                      <label className="default-source">
                        {t('defaultDatabase')}
                        <select
                          aria-label={t('defaultDatabase')}
                          value={scope.defaultDatabase ?? ''}
                          disabled={busy || running}
                          onChange={(event) => {
                            setScope(previous => ({
                              ...previous,
                              defaultDatabase: event.target.value || null,
                            }))
                          }}
                        >
                          <option value="">{t('noSource')}</option>
                          {catalog.sources
                            .filter(source => scope.sources.some(item => item.database === source.id))
                            .map(source => (
                              <option key={source.id} value={source.id}>
                                {source.name}
                              </option>
                            ))}
                        </select>
                      </label>
                    </>
                  ) : (
                    <KnowledgeLibrary key={`${active.id}:${tab}`} sessionId={sessionId} database={active.id}
                      category={tab} running={running} />
                  )}
                </>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  )
}
