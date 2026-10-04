/** Narrow provider edits preserve adapter fields not exposed by the model form. */
import Schema from '@deepseek-ai/schemastery'
import type { SettingsNamespaceView, SettingsPathOpView, LlmDiscoveredModel } from '../protocol/models.ts'
import { t } from '../copy.ts'

type JsonValue = SettingsNamespaceView['value']
type JsonObject = { [key: string]: JsonValue }

/** One editable model with its unexposed adapter settings retained. */
export interface ModelDraft {
  id: string
  name: string
  contextWindow: string
  maxTokens: string
  image: boolean
  original: JsonObject
}

/** Provider form values; API keys are deliberately separate from this draft. */
export interface ProviderDraft {
  route: string
  name: string
  baseURL: string
  api: string
  models: ModelDraft[]
}

/** Read a JSON object without coercing primitives or arrays. */
export function objectValue(value: JsonValue | undefined): JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? value : {}
}

/** Read a nested JSON settings value. */
export function valueAt(value: JsonValue | undefined, path: readonly string[]): JsonValue | undefined {
  for (const key of path) value = objectValue(value)[key]
  return value
}

/** Derive the same conventional credential reference as the original Models page. */
export function keyReference(route: string): string {
  return `${route.toUpperCase().replace(/[^A-Z0-9]+/gu, '_')}_API_KEY`
}

/** Read protocol choices from the active adapter's schema, rather than a separate allowlist. */
export function modelProtocols(view: SettingsNamespaceView | undefined): string[] {
  if (!view) return []
  const root: Partial<Schema> = new Schema(objectValue(view.schema))
  const providers: Partial<Schema> | undefined = root.dict?.providers
  const profile: Partial<Schema> | undefined = providers?.inner
  const api: Partial<Schema> | undefined = profile?.dict?.api
  const protocols: string[] = []
  for (const entry of api?.list ?? []) {
    const value: unknown = entry.value
    if (typeof value === 'string') protocols.push(value)
  }
  return protocols
}

/** Convert existing configuration or discovery metadata into an editable model. */
export function modelDraft(model: JsonObject = { id: '' }): ModelDraft {
  const raw: JsonObject = { ...model }
  const input = raw.input ?? raw.inputModalities
  return {
    id: typeof raw.id === 'string' ? raw.id : '',
    name: typeof raw.name === 'string' ? raw.name : '',
    contextWindow: typeof raw.contextWindow === 'number' ? String(raw.contextWindow) : '',
    maxTokens: typeof raw.maxTokens === 'number' ? String(raw.maxTokens) : '',
    image: Array.isArray(input) && input.includes('image'),
    original: raw,
  }
}

/** Adopt a discovery candidate without storing absent fields or its wire-only metadata. */
export function discoveredDraft(model: LlmDiscoveredModel): ModelDraft {
  return modelDraft({
    id: model.id,
    ...(model.name === undefined ? {} : { name: model.name }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    ...(model.inputModalities === undefined ? {} : { input: [...model.inputModalities] }),
  })
}

/** Normalize a redacted provider profile for the editor. */
export function providerDraft(route: string, value: JsonValue | undefined): ProviderDraft {
  const raw = objectValue(value)
  return {
    route, name: typeof raw.displayName === 'string' ? raw.displayName : '',
    baseURL: typeof raw.baseURL === 'string' ? raw.baseURL : '',
    api: typeof raw.api === 'string' ? raw.api : '',
    models: Array.isArray(raw.models) ? raw.models.map(model => modelDraft(objectValue(model))) : [],
  }
}

/** Validate fields locally; the Host remains the authoritative configuration validator. */
export function draftFailure(draft: ProviderDraft, creating: boolean, taken: readonly string[], key: string): string | undefined {
  if (creating && !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/u.test(draft.route)) return t('routeInvalid')
  if (creating && taken.includes(draft.route)) return t('routeTaken')
  if (draft.baseURL) {
    try {
      const url = new URL(draft.baseURL)
      if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return t('endpointInvalid')
    } catch { return t('endpointInvalid') }
  } else if (creating) return t('endpointInvalid')
  if (creating && !draft.api) return t('protocolRequired')
  if (creating && draft.models.length === 0) return t('modelRequired')
  const ids = new Set<string>()
  for (const model of draft.models) {
    const id = model.id.trim()
    if (!id || ids.has(id)) return t('modelIdsInvalid')
    ids.add(id)
    for (const value of [model.contextWindow, model.maxTokens]) {
      if (value !== '' && (!/^\d+$/u.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) < 1)) return t('capacityInvalid')
    }
    if (model.contextWindow && model.maxTokens && Number(model.maxTokens) > Number(model.contextWindow)) return t('capacityInvalid')
  }
  if (key.length && (!key.trim() || !/^[\x21-\x7e]+$/u.test(key.trim()))) return t('keyInvalid')
  return undefined
}

/** Build path-addressed writes, leaving hidden provider and model fields intact. */
export function providerEdits(draft: ProviderDraft, path: readonly string[], keyRef: string | undefined): SettingsPathOpView[] {
  const models: JsonObject[] = draft.models.map((model) => {
    const { inputModalities: _discoveredInput, ...original } = model.original
    const result: JsonObject = { ...original, id: model.id.trim() }
    for (const [field, value] of [['name', model.name], ['contextWindow', model.contextWindow], ['maxTokens', model.maxTokens]]) {
      if (value) result[field] = field === 'name' ? value.trim() : Number(value)
      else Reflect.deleteProperty(result, field)
    }
    if (model.image) result.input = ['text', 'image']
    else if (Object.hasOwn(original, 'input')) result.input = ['text']
    return result
  })
  const fields: JsonObject = {
    ...(draft.name ? { displayName: draft.name.trim() } : {}),
    ...(draft.baseURL ? { baseURL: draft.baseURL.trim() } : {}),
    ...(draft.api ? { api: draft.api } : {}),
    ...(models.length ? { models } : {}),
    ...(keyRef ? { apiKeyEnv: keyRef } : {}),
  }
  return [
    ...Object.entries(fields).map(([field, value]): SettingsPathOpView => ({ op: 'set', path: [...path, field], value })),
    ...['displayName', 'baseURL', 'api', 'models'].filter(field => !Object.hasOwn(fields, field))
      .map((field): SettingsPathOpView => ({ op: 'unset', path: [...path, field] })),
  ]
}
