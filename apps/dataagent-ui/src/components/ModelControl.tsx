/** Session-aware model picker over the original Harness selection projection. */
import { useEffect, useRef, useState } from 'react'
import { Cpu, LoaderCircle, Settings2 } from 'lucide-react'
import { modelCatalog, sessionModel, selectModel } from '../protocol/models.ts'
import type { ModelCatalog, ModelSelection, ModelSelectionProjection } from '../protocol/models.ts'
import { t } from '../copy.ts'

interface Props {
  sessionId?: string
  eventSeq: number
  revision: number
  running: boolean
  manage: () => void
}

/** Render actual request selection and independently editable next-request selection. */
export function ModelControl({ sessionId, eventSeq, revision, running, manage }: Props): React.JSX.Element {
  const [catalog, setCatalog] = useState<ModelCatalog>()
  const [selection, setSelection] = useState<ModelSelectionProjection>()
  const [failure, setFailure] = useState<string>()
  const [catalogFailure, setCatalogFailure] = useState<string>()
  const [busy, setBusy] = useState(false)
  const targetRef = useRef(sessionId)
  targetRef.current = sessionId
  const operationRef = useRef(0)

  useEffect(() => {
    operationRef.current++
    setSelection(undefined)
    setBusy(false)
    setFailure(undefined)
  }, [sessionId])

  useEffect(() => {
    let disposed = false
    let inflight = false
    const load = async () => {
      if (inflight) return
      inflight = true
      try {
        const value = await modelCatalog()
        if (!disposed) { setCatalog(value); setCatalogFailure(undefined) }
      } catch (error) {
        if (!disposed) setCatalogFailure(String(error))
      } finally { inflight = false }
    }
    void load()
    const timer = setInterval(() => { void load() }, 10000)
    const focus = () => { void load() }
    window.addEventListener('focus', focus)
    return () => { disposed = true; clearInterval(timer); window.removeEventListener('focus', focus) }
  }, [revision])

  useEffect(() => {
    let disposed = false
    const operation = operationRef.current
    if (!sessionId) { setSelection(undefined); return }
    void sessionModel(sessionId).then((value) => {
      if (!disposed && operation === operationRef.current) setSelection(value)
    }).catch((error: unknown) => { if (!disposed && operation === operationRef.current) setFailure(String(error)) })
    return () => { disposed = true }
  }, [sessionId, eventSeq, revision])

  const next = selection?.next ?? catalog?.default
  const used = selection?.lastUsed
  const display = used ?? next
  const modelKey = (model: ModelSelection) => JSON.stringify([model.provider, model.model])
  const options = catalog?.groups.flatMap(group => group.models.map(model => ({ group, model }))) ?? []
  const available = next && options.some(option => option.group.id === next.provider && option.model.id === next.model)
  const reasoning = next && options.find(option => option.group.id === next.provider && option.model.id === next.model)?.model.reasoning

  const choose = async (value: ModelSelection) => {
    if (!sessionId) return
    const operation = ++operationRef.current
    setBusy(true)
    setFailure(undefined)
    try {
      const result = await selectModel(sessionId, value)
      if (targetRef.current !== sessionId) return
      // Read after the write: a request may already have consumed the selection.
      const actual = await sessionModel(sessionId)
      if (operation === operationRef.current) setSelection(actual ?? { lastUsed: used ?? null, next: result.selected })
    } catch (error) {
      if (targetRef.current === sessionId) setFailure(String(error))
    } finally { if (operation === operationRef.current) setBusy(false) }
  }

  return <div className="model-control">
    <div className="model-control-row">
      <Cpu size={14} />
      <span className="model-label">{t(running ? 'currentModel' : used ? 'lastModel' : 'modelDefault')}</span>
      <span className="model-used" title={display ? `${display.provider} / ${display.model}` : t('loading')}>
        {display ? `${display.provider} / ${display.model}` : t('loading')}
      </span>
      <button className="model-icon" title={t('manageModels')} aria-label={t('manageModels')} onClick={manage}><Settings2 size={15} /></button>
    </div>
    <div className="model-control-row model-next-row">
      <label className="model-label" htmlFor="next-model">{t('nextModel')}</label>
      <select id="next-model" value={next ? modelKey(next) : ''} disabled={busy || !sessionId || !catalog} onChange={(event) => {
        const option = options.find(item => modelKey({ provider: item.group.id, model: item.model.id }) === event.target.value)
        if (option) void choose({ provider: option.group.id, model: option.model.id })
      }}>
        {!available && <option value={next ? modelKey(next) : ''}>{next ? `${next.provider} / ${next.model}` : t('loading')}</option>}
        {catalog?.groups.map(group => <optgroup key={group.id} label={group.name}>{group.models.map(model =>
          <option key={model.id} value={modelKey({ provider: group.id, model: model.id })}>{model.name}</option>,
        )}</optgroup>)}
      </select>
      {reasoning && <select aria-label={t('reasoningEffort')} value={next.reasoningEffort ?? reasoning.defaultEffort ?? ''} disabled={busy} onChange={(event) => {
        void choose({ ...next, reasoningEffort: event.target.value })
      }}>{reasoning.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}</select>}
      {busy && <LoaderCircle size={14} className="spin" aria-label={t('loading')} />}
    </div>
    {(failure || catalogFailure || catalog?.failures.length) ? <details className="model-control-error"><summary>{t(failure ? 'modelOperationFailed' : 'modelUnavailable')}</summary>
      {failure ?? catalogFailure ?? catalog?.failures.map(item => `${item.name}: ${item.message}`).join('\n')}
    </details> : null}
  </div>
}
