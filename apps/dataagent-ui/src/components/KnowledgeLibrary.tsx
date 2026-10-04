/** Source-scoped multi-document knowledge workspace with explicit item operations. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { Check, Download, FileText, LoaderCircle, Plus, RefreshCw, Search, Trash2, Upload, X } from 'lucide-react'
import { t } from '../copy.ts'
import { sourceRequest } from '../protocol/sources.ts'
import type { KnowledgeDocument, SourceKnowledge } from '../protocol/sources.ts'
import { Markdown } from './Markdown.tsx'

/**
 * Manage reference documents without replacing live metadata or changing table permissions.
 * @param props - Source, document category, and analysis activity.
 * @returns Source-scoped document list and reading pane.
 */
export function KnowledgeLibrary({ sessionId, database, category, running }: {
  sessionId: string
  database: string
  category: 'schema' | 'business'
  running: boolean
}) {
  const [documents, setDocuments] = useState<KnowledgeDocument[]>()
  const [selectedId, setSelectedId] = useState('')
  const [filter, setFilter] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [removing, setRemoving] = useState('')
  const live = useRef(true)
  const generation = useRef(0)
  const query = `sessionId=${encodeURIComponent(sessionId)}&database=${encodeURIComponent(database)}&category=${category}`
  const reload = useCallback(async () => {
    const current = ++generation.current
    const result = await sourceRequest<SourceKnowledge>(`knowledge?${query}`)
    if (!live.current || current !== generation.current) return
    setDocuments(result.documents)
    setSelectedId(previous => result.documents.some(item => item.id === previous) ? previous : result.documents[0]?.id ?? '')
  }, [query])
  useEffect(() => {
    live.current = true
    void reload().catch((cause: unknown) => {
      if (live.current) setError(cause instanceof Error ? cause.message : t('documentLoadFailed'))
    })
    return () => { live.current = false }
  }, [reload])
  const operation = async (run?: () => Promise<void>, message = t('documentSaved')) => {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await run?.()
      if (live.current) setNotice(message)
    } catch (cause) {
      if (live.current) setError(cause instanceof Error ? cause.message : t('sourceOperationFailed'))
    } finally {
      try { await reload() } catch (cause) {
        if (live.current) setError(cause instanceof Error ? cause.message : t('documentLoadFailed'))
      }
      if (live.current) { setBusy(false); setRemoving('') }
    }
  }
  const selected = documents?.find(item => item.id === selectedId)
  const blocked = busy || running || !documents
  const origin = (document: KnowledgeDocument) => t(document.origin === 'configured' ? 'documentConfigured' : 'documentUploaded')
  const upload = (files: File[], replace?: KnowledgeDocument) => operation(async () => {
    for (const file of files) {
      const result = await sourceRequest<{ id: string }>(`${category}/upload`, {
        database, filename: file.name, markdown: await file.text(),
        ...(replace ? { replace: { id: replace.id, version: replace.version } } : {}),
      })
      if (live.current) setSelectedId(result.id)
    }
  })
  return (
    <section className="knowledge-library" aria-label={t(category === 'schema' ? 'schemaLibrary' : 'businessLibrary')}>
      <div className="knowledge-toolbar">
        <label className="knowledge-search">
          <Search size={15} />
          <input value={filter} placeholder={t('filterDocuments')} aria-label={t('filterDocuments')}
            onChange={(event) => { setFilter(event.target.value) }} />
        </label>
        <label className={`manager-command upload-label${blocked ? ' disabled' : ''}`}>
          <Plus size={15} />{t('addDocuments')}
          <input type="file" multiple accept=".md,text/markdown" disabled={blocked} aria-label={t('addDocuments')}
            onChange={(event) => {
              const files = Array.from(event.target.files ?? [])
              event.target.value = ''
              if (files.length) void upload(files)
            }} />
        </label>
        <button className="knowledge-icon" title={t('refreshSchema')} aria-label={t('refreshSchema')}
          disabled={busy} onClick={() => void operation()}><RefreshCw size={16} /></button>
      </div>
      <div className="knowledge-feedback" role="status">
        {busy ? <LoaderCircle className="spin" size={15} /> : error || notice}
      </div>
      <div className="knowledge-workspace">
        <div className="knowledge-list">
          {!documents ? <LoaderCircle className="spin" size={20} /> : documents
            .filter(item => item.filename.toLowerCase().includes(filter.toLowerCase()))
            .map(document => (
              <div className={`knowledge-row${document.id === selectedId ? ' active' : ''}`} key={document.id}>
                <input type="checkbox" checked={document.enabled} disabled={blocked}
                  aria-label={`${t('enableDocument')} ${document.filename}`}
                  onChange={(event) => {
                    const enabled = event.target.checked
                    setDocuments(previous => previous?.map(item => item.id === document.id ? { ...item, enabled } : item))
                    void operation(async () => {
                      await sourceRequest('knowledge/change', {
                        sessionId, database, category, id: document.id, version: document.version,
                        action: { enabled },
                      })
                    })
                  }} />
                <button className="knowledge-select" aria-pressed={document.id === selectedId}
                  onClick={() => { setSelectedId(document.id); setRemoving('') }}>
                  <span><FileText size={14} /><strong>{document.filename}</strong></span>
                  <small>{origin(document)}<span>{document.version.slice(0, 8)}</span></small>
                </button>
              </div>
            ))}
          {documents && !documents.some(item => item.filename.toLowerCase().includes(filter.toLowerCase())) &&
            <p className="knowledge-empty">{t('noDocuments')}</p>}
        </div>
        <div className="knowledge-detail">
          {selected ? <>
            <header className="knowledge-document-heading">
              <div><h3>{selected.filename}</h3><small>{origin(selected)} · {selected.version.slice(0, 12)}
                {selected.uploadedAt ? ` · ${selected.uploadedAt}` : ''}</small></div>
              <a className="knowledge-icon" title={t('downloadDocument')} aria-label={t('downloadDocument')}
                href={`/api/data-agent/knowledge/download?${query}&id=${selected.id}&version=${selected.version}`}>
                <Download size={16} />
              </a>
              {selected.origin === 'uploaded' && <>
                <label className={`knowledge-icon upload-label${blocked ? ' disabled' : ''}`}
                  title={t('replaceDocument')}>
                  <Upload size={16} />
                  <input type="file" accept=".md,text/markdown" disabled={blocked} aria-label={t('replaceDocument')}
                    onChange={(event) => {
                      const file = event.target.files?.[0]
                      event.target.value = ''
                      if (file) void upload([file], selected)
                    }} />
                </label>
                <button className="knowledge-icon" disabled={blocked} title={t('removeDocument')}
                  aria-label={t('removeDocument')} onClick={() => { setRemoving(selected.id) }}><Trash2 size={16} /></button>
              </>}
            </header>
            {removing === selected.id && <div className="knowledge-confirm">
              <span>{selected.filename}</span>
              <button className="manager-command" disabled={blocked} onClick={() => void operation(async () => {
                await sourceRequest('knowledge/change', { sessionId, database, category,
                  id: selected.id, version: selected.version, action: { remove: true } })
              }, t('documentRemoved'))}><Check size={15} />{t('confirmRemoveDocument')}</button>
              <button className="knowledge-icon" aria-label={t('cancelOperation')} onClick={() => { setRemoving('') }}><X size={16} /></button>
            </div>}
            <div className="schema-document"><Markdown text={selected.markdown} renderImages={false} /></div>
          </> : <p className="knowledge-empty">{t(documents?.length ? 'selectDocument' : 'noDocuments')}</p>}
        </div>
      </div>
    </section>
  )
}
