/** Desktop provider editor using Harness live settings and credential services. */
import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowLeft, Check, Cpu, KeyRound, LoaderCircle, Plus, RefreshCw, Save, Trash2, X } from 'lucide-react'
import {
  credentialInfo, discoverModels, modelCatalog, modelProviders, modelSettings,
  storeModelKey, writeModelSettings,
} from '../protocol/models.ts'
import type {
  CredentialInfo, LlmConfigurableProvider, LlmDiscoveredModel, ModelCatalog, SettingsNamespaceView,
} from '../protocol/models.ts'
import {
  discoveredDraft, draftFailure, keyReference, modelDraft, modelProtocols, objectValue, providerDraft, providerEdits, valueAt,
} from '../state/model-draft.ts'
import type { ProviderDraft } from '../state/model-draft.ts'
import { RpcError } from '../protocol/api.ts'
import { t } from '../copy.ts'

interface Row {
  entry: LlmConfigurableProvider
  view: SettingsNamespaceView
  removable: boolean
  ref: string
  credential?: CredentialInfo
}
interface Editor {
  view: SettingsNamespaceView
  row?: Row
}

function failureText(error: unknown): string {
  return error instanceof RpcError && error.code === 'settings/conflict' ? t('settingsConflict') : String(error)
}

/** Render the global model connection workspace without requiring an active analysis. */
export function ModelManager({ close, changed }: { close: () => void; changed: () => void }): React.JSX.Element {
  const [rows, setRows] = useState<Row[]>([])
  const [pi, setPi] = useState<SettingsNamespaceView>()
  const [catalog, setCatalog] = useState<ModelCatalog>()
  const [writable, setWritable] = useState(false)
  const [loading, setLoading] = useState(true)
  const [notice, setNotice] = useState<string>()
  const [failure, setFailure] = useState<string>()
  const [editor, setEditor] = useState<Editor>()
  const [epoch, setEpoch] = useState(0)
  const generation = useRef(0)

  const load = useCallback(async () => {
    const current = ++generation.current
    setFailure(undefined)
    try {
      const settings = await modelSettings()
      const providers = await modelProviders()
      const catalog = await modelCatalog()
      const next = providers.flatMap((entry) => {
        const view = settings.namespaces.find(view => view.ns === entry.settingsNs)
        if (!view || valueAt(view.value, entry.settingsPath) === undefined) return []
        const profile = objectValue(valueAt(view.value, entry.settingsPath))
        const ref = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : keyReference(entry.provider)
        return [{ entry, view, ref, removable: entry.settingsPath.length > 0
          && valueAt(view.user, entry.settingsPath) !== undefined && valueAt(view.base, entry.settingsPath) === undefined }]
      })
      let credentials: Record<string, CredentialInfo> = {}
      let keyFailure: string | undefined
      try { credentials = await credentialInfo([...new Set(next.map(row => row.ref))]) }
      catch (error) { keyFailure = String(error) }
      if (current !== generation.current) return
      setRows(next.map(row => ({ ...row, credential: credentials[row.ref] })))
      setPi(settings.namespaces.find(view => view.ns === 'llm-pi-ai'))
      setCatalog(catalog)
      setWritable(settings.writable)
      setFailure(keyFailure)
    } catch (error) { if (current === generation.current) setFailure(failureText(error)) }
    finally { if (current === generation.current) setLoading(false) }
  }, [])

  useEffect(() => {
    void load()
    const focus = () => { void load() }
    window.addEventListener('focus', focus)
    return () => { generation.current++; window.removeEventListener('focus', focus) }
  }, [load])

  const done = (message: string) => {
    setEditor(undefined)
    setNotice(message)
    changed()
    void load()
  }
  const open = (value: Editor) => { setEditor(value); setEpoch(value => value + 1); setNotice(undefined) }

  return <section className="source-manager model-manager">
    <header className="manager-heading">
      <button className="manager-command" title={t('backAnalysis')} aria-label={t('backAnalysis')} onClick={close}><ArrowLeft size={16} /></button>
      <h1>{t('manageModels')}</h1>
      <button className="manager-command" disabled={!pi || !writable || !!editor} onClick={() => { if (pi) open({ view: pi }) }}><Plus size={16} />{t('addModelApi')}</button>
    </header>
    {notice && <div className="manager-notice" role="status"><Check size={16} />{notice}</div>}
    {failure && <div className="manager-notice manager-error" role="alert">{failure}</div>}
    {!loading && (!writable || !pi) && <div className="manager-notice manager-error">{t(pi ? 'settingsReadOnly' : 'modelApiUnavailable')}</div>}
    <div className="manager-grid model-manager-grid">
      <nav className="manager-sources" aria-label={t('provider')}>
        <div className="manager-section-title"><h2>{t('provider')}</h2><button title={t('refreshModels')} aria-label={t('refreshModels')} onClick={() => { void load() }}><RefreshCw size={15} /></button></div>
        {loading && <LoaderCircle size={18} className="spin" aria-label={t('loading')} />}
        {rows.map(row => <button key={row.entry.provider} className={`model-provider-row${editor?.row?.entry.provider === row.entry.provider ? ' active' : ''}`} onClick={() =>{  open({ row, view: row.view }) }}>
          <Cpu size={16} /><span>{row.entry.displayName}<small>{row.entry.provider}</small><small>{t(row.removable ? 'customProvider' : 'inheritedProvider')}</small></span>
          <span className={`model-key-status${row.credential?.configured ? ' configured' : ''}`} title={t(row.credential?.configured ? 'keyConfigured' : 'keyNotConfigured')}><KeyRound size={13} /></span>
        </button>)}
      </nav>
      <div className="manager-detail">
        {editor ? <ProviderEditor key={epoch} editor={editor} writable={writable} taken={rows.map(row => row.entry.provider)}
          cancel={() => { setEditor(undefined) }} done={done} /> : <>
          <div className="schema-heading"><h2>{t('configuredModels')}</h2><span>{catalog?.groups.reduce((count, group) => count + group.models.length, 0) ?? 0}</span></div>
          <div className="model-catalog-list">{catalog?.groups.map(group => <section key={group.id}>
            <h3>{group.name}<small>{group.id}</small></h3>
            {group.models.map(model => <div className="model-catalog-row" key={model.id}><span>{model.name}</span><code>{model.id}</code>{catalog.default.provider === group.id && catalog.default.model === model.id && <small>{t('modelDefault')}</small>}</div>)}
          </section>)}</div>
          {catalog?.failures.map(item => <p className="model-field-error" key={item.id}>{item.name}: {item.message}</p>)}
        </>}
      </div>
    </div>
  </section>
}

function ProviderEditor({ editor, writable, taken, cancel, done }: {
  editor: Editor
  writable: boolean
  taken: readonly string[]
  cancel: () => void
  done: (message: string) => void
}): React.JSX.Element {
  const { view, row } = editor
  const creating = !row
  const path = row?.entry.settingsPath ?? ['providers']
  const [draft, setDraft] = useState(() => providerDraft(row?.entry.provider ?? '', row ? valueAt(view.value, path) : undefined))
  const [key, setKey] = useState('')
  const [busy, setBusy] = useState(false)
  const [committed, setCommitted] = useState(false)
  const commitRef = useRef(false)
  const [failure, setFailure] = useState<string>()
  const [candidates, setCandidates] = useState<LlmDiscoveredModel[]>()
  const [remove, setRemove] = useState(false)
  const pi = view.ns === 'llm-pi-ai'
  const protocols = modelProtocols(pi ? view : undefined)
  const disabled = !writable || busy
  const profileDisabled = disabled || committed || !pi
  const profile = objectValue(row ? valueAt(view.value, path) : undefined)
  const ref = typeof profile.apiKeyEnv === 'string' ? profile.apiKeyEnv : keyReference(draft.route)
  const update = (value: Partial<ProviderDraft>) =>{  setDraft(previous => ({ ...previous, ...value })) }
  const error = draftFailure(draft, creating, taken, key)
  const missingModels = pi && row?.entry.declared === true && draft.models.length === 0
  const keyDisabled = disabled || row?.credential?.writable === false

  const save = async () => {
    setBusy(true)
    setFailure(undefined)
    try {
      if (!commitRef.current) {
        const address = creating ? ['providers', draft.route] : [...path]
        const ops = pi ? providerEdits(draft, address, key.trim() ? ref : undefined)
          : key.trim() ? [{ op: 'set' as const, path: [...address, 'apiKeyEnv'], value: ref }] : []
        if (ops.length) await writeModelSettings(view.ns, ops, view.revision)
        commitRef.current = true
        setCommitted(true)
      }
      if (key.trim()) await storeModelKey(ref, key.trim())
      setKey('')
      done(t('modelApiSaved'))
    } catch (error) {
      setFailure(`${commitRef.current && key.trim() ? `${t('modelKeyPending')}: ` : ''}${failureText(error)}`)
    } finally { setBusy(false) }
  }

  const discover = async () => {
    setBusy(true)
    setFailure(undefined)
    try {
      const found = await discoverModels(view.ns, {
        ...(row ? { provider: row.entry.provider } : {}), baseURL: draft.baseURL.trim(),
        ...(draft.api ? { api: draft.api } : {}), ...(key.trim() ? { apiKey: key.trim() } : {}),
      })
      setCandidates(found)
    } catch (error) { setFailure(failureText(error)) }
    finally { setBusy(false) }
  }

  const removeProvider = async () => {
    if (!row?.removable) return
    setBusy(true)
    setFailure(undefined)
    try {
      await writeModelSettings(view.ns, [{ op: 'unset', path: [...path] }], view.revision)
      done(t('modelApiRemoved'))
    } catch (error) { setFailure(failureText(error)) }
    finally { setBusy(false) }
  }

  return <form className="model-form" onSubmit={(event) => { event.preventDefault(); void save() }}>
    <div className="schema-heading"><h2>{creating ? t('addModelApi') : row.entry.displayName}</h2><button type="button" title={t('cancelEdit')} aria-label={t('cancelEdit')} disabled={busy} onClick={cancel}><X size={16} /></button></div>
    <fieldset disabled={profileDisabled} className="model-profile-fields">
      <div className="model-form-grid">
        <label>{t('providerRoute')}<input value={draft.route} disabled={!creating} onChange={(event) =>{  update({ route: event.target.value }) }} placeholder="my-gateway" autoComplete="off" required /></label>
        <label>{t('providerName')}<input value={draft.name} onChange={(event) =>{  update({ name: event.target.value }) }} /></label>
        <label className="model-form-wide">{t('endpoint')}<input type="url" value={draft.baseURL} onChange={(event) =>{  update({ baseURL: event.target.value }) }} placeholder="https://api.example.com/v1" required={creating} /></label>
        <label>{t('protocol')}<select aria-label={t('protocol')} value={draft.api} onChange={(event) =>{  update({ api: event.target.value }) }} required={creating}>
          {!draft.api && <option value="">{t('protocolRequired')}</option>}
          {draft.api && !protocols.includes(draft.api) && <option value={draft.api}>{draft.api}</option>}
          {protocols.map(api => <option key={api} value={api}>{({ 'openai-completions': 'OpenAI Chat Completions', 'openai-responses': 'OpenAI Responses', 'anthropic-messages': 'Anthropic Messages' } as Record<string, string>)[api] ?? api}</option>)}
        </select></label>
      </div>
    </fieldset>
    <label className="model-key-field">{t('apiKey')}<span><KeyRound size={13} />{row?.credential && t(row.credential.configured ? 'keyConfigured' : 'keyNotConfigured')}{row?.credential?.source && ` (${row.credential.source})`}</span>
      <input aria-label={t('apiKey')} type="password" value={key} disabled={keyDisabled} autoComplete="new-password" spellCheck={false} placeholder={t(creating ? 'keyOptionalCreate' : 'keyOptional')} onChange={(event) =>{  setKey(event.target.value) }} />
    </label>
    {row?.credential?.writable === false && <p className="model-field-error">{t('keyReadOnly')}</p>}
    {pi && <fieldset disabled={profileDisabled} className="model-model-fields">
      <div className="model-list-heading"><h3>{t('apiModels')}</h3><button type="button" className="manager-command" disabled={!draft.baseURL && !row} onClick={() => { void discover() }}><RefreshCw size={14} />{t('discoverModels')}</button><button type="button" className="model-icon" title={t('addModel')} aria-label={t('addModel')} onClick={() =>{  update({ models: [...draft.models, modelDraft()] }) }}><Plus size={17} /></button></div>
      <div className="model-edit-list">{draft.models.map((model, index) => <div className="model-edit-row" key={index}>
        <label>{t('modelId')}<input value={model.id} required onChange={(event) =>{  update({ models: draft.models.map((value, i) => i === index ? { ...value, id: event.target.value } : value) }) }} /></label>
        <label>{t('modelName')}<input value={model.name} onChange={(event) =>{  update({ models: draft.models.map((value, i) => i === index ? { ...value, name: event.target.value } : value) }) }} /></label>
        <label>{t('contextWindow')}<input type="number" min="1" step="1" value={model.contextWindow} onChange={(event) =>{  update({ models: draft.models.map((value, i) => i === index ? { ...value, contextWindow: event.target.value } : value) }) }} /></label>
        <label>{t('maxTokens')}<input type="number" min="1" step="1" value={model.maxTokens} onChange={(event) =>{  update({ models: draft.models.map((value, i) => i === index ? { ...value, maxTokens: event.target.value } : value) }) }} /></label>
        <label className="checkbox-label"><input type="checkbox" checked={model.image} onChange={(event) =>{  update({ models: draft.models.map((value, i) => i === index ? { ...value, image: event.target.checked } : value) }) }} />{t('imageInput')}</label>
        <button type="button" className="model-icon" title={t('removeModel')} aria-label={t('removeModel')} onClick={() =>{  update({ models: draft.models.filter((_, i) => i !== index) }) }}><Trash2 size={15} /></button>
      </div>)}</div>
      {candidates && <div className="model-candidates"><h3>{t('discoveryCandidates')}</h3>{!candidates.length && <p>{t('discoveryEmpty')}</p>}{candidates.map(candidate => <label className="checkbox-label" key={candidate.id}><input type="checkbox" checked={draft.models.some(model => model.id === candidate.id)} onChange={(event) =>{  update({ models: event.target.checked ? [...draft.models, discoveredDraft(candidate)] : draft.models.filter(model => model.id !== candidate.id) }) }} /><span>{candidate.name ?? candidate.id}<code>{candidate.id}</code></span></label>)}</div>}
    </fieldset>}
    {(failure || error || missingModels) && <p className="model-field-error" role="alert">{failure ?? error ?? t('modelRequired')}</p>}
    {row?.entry.error && <p className="model-field-error">{row.entry.error}</p>}
    <div className="model-form-footer">
      <button type="submit" className="manager-command" disabled={disabled || !!error || missingModels || (committed && !key.trim())}>{busy ? <LoaderCircle size={15} className="spin" /> : <Save size={15} />}{t(committed ? 'retryModelKey' : 'saveModelApi')}</button>
      {row?.removable && !committed && <button type="button" className="model-icon" title={t('removeModelApi')} aria-label={t('removeModelApi')} disabled={disabled} onClick={() =>{  setRemove(true) }}><Trash2 size={16} /></button>}
      {remove && <><button type="button" className="manager-command" disabled={disabled} onClick={() => { void removeProvider() }}>{t('confirmRemoveApi')}</button><button type="button" className="manager-command" disabled={busy} onClick={() =>{  setRemove(false) }}>{t('cancelEdit')}</button></>}
    </div>
  </form>
}
