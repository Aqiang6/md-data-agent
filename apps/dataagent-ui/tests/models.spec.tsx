// @vitest-environment jsdom
/// <reference types="vite/client" />
/** Model picker and write-only provider configuration over the existing Host API. */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import recordedModelSwitch from '../../../snapshots/session/model-switch-notice/session.v3.jsonl?raw'
import Schema from '@deepseek-ai/schemastery'
import { ModelControl } from '../src/components/ModelControl.tsx'
import { ModelManager } from '../src/components/ModelManager.tsx'
import * as api from '../src/protocol/models.ts'
import { RpcError } from '../src/protocol/api.ts'
import { discoveredDraft, draftFailure, keyReference, modelDraft, modelProtocols, providerDraft, providerEdits } from '../src/state/model-draft.ts'
import type { ModelCatalog, ModelSelection, SettingsNamespaceView } from '../src/protocol/models.ts'
import { t } from '../src/copy.ts'

vi.mock('../src/protocol/models.ts')
afterEach(() => { cleanup(); vi.restoreAllMocks() })

const provider = { api: 'openai-completions', baseURL: 'https://example.test/v1', models: [{ id: 'current', name: 'Current', compat: { supportsDeveloperRole: false } }], headers: { 'x-local': 'preserved' } }
const namespace = (): SettingsNamespaceView => ({
  ns: 'llm-pi-ai', autoGenerate: true, applies: 'live', revision: 7, secrets: [],
  schema: JSON.parse(JSON.stringify(Schema.object({ providers: Schema.dict(Schema.object({ api: Schema.union(['openai-completions', 'openai-responses', 'anthropic-messages']) })) }).toJSON())) as SettingsNamespaceView['schema'],
  value: { providers: { gateway: provider } }, base: { providers: {} }, user: { providers: { gateway: provider } },
})
const catalog: ModelCatalog = { default: { provider: 'gateway', model: 'current' }, routableProviders: ['gateway'], failures: [], groups: [{ id: 'gateway', name: 'Gateway', models: [{ id: 'current', name: 'Current' }, { id: 'next', name: 'Next' }] }] }

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(api.modelCatalog).mockResolvedValue(catalog)
  vi.mocked(api.modelSettings).mockResolvedValue({ namespaces: [namespace()], writable: true, hasDocument: true })
  vi.mocked(api.modelProviders).mockResolvedValue([{ provider: 'gateway', displayName: 'Gateway', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'gateway'], declared: true }])
  vi.mocked(api.credentialInfo).mockResolvedValue({ GATEWAY_API_KEY: { configured: false, writable: true } })
  vi.mocked(api.sessionModel).mockResolvedValue({ lastUsed: { provider: 'gateway', model: 'current' }, next: { provider: 'gateway', model: 'next' } })
  vi.mocked(api.selectModel).mockResolvedValue({ selected: { provider: 'gateway', model: 'next' } })
  vi.mocked(api.writeModelSettings).mockResolvedValue({ ...namespace(), revision: 8 })
  vi.mocked(api.storeModelKey).mockResolvedValue(undefined)
})

it('reads protocols from the Host schema and preserves unexposed model settings in narrow edits', () => {
  expect(modelProtocols(namespace())).toEqual(['openai-completions', 'openai-responses', 'anthropic-messages'])
  const draft = providerDraft('gateway', provider)
  draft.models[0].name = 'Renamed'
  const ops = providerEdits(draft, ['providers', 'gateway'], undefined)
  expect(ops).toContainEqual({ op: 'set', path: ['providers', 'gateway', 'models'], value: [{ id: 'current', name: 'Renamed', compat: { supportsDeveloperRole: false } }] })
  expect(ops.some(op => op.path.includes('headers') || op.path.includes('apiKeyEnv'))).toBe(false)
  expect(ops).toContainEqual({ op: 'unset', path: ['providers', 'gateway', 'displayName'] })
  expect(keyReference('my-gateway')).toBe('MY_GATEWAY_API_KEY')
  expect(discoveredDraft({ id: 'vision', inputModalities: ['text', 'image'], contextWindow: 65536 }).image).toBe(true)
})

it('refuses invalid endpoints, duplicate IDs and incorrect capacities before saving', () => {
  const draft = providerDraft('new-route', provider)
  expect(draftFailure(draft, true, [], '')).toBeUndefined()
  expect(draftFailure(draft, true, ['new-route'], '')).toBe(t('routeTaken'))
  expect(draftFailure({ ...draft, route: '1-route' }, true, [], '')).toBe(t('routeInvalid'))
  for (const baseURL of ['file:///tmp/model', 'https://key:secret@example.test/v1', 'invalid']) expect(draftFailure({ ...draft, baseURL }, true, [], '')).toBe(t('endpointInvalid'))
  expect(draftFailure({ ...draft, models: [modelDraft({ id: 'same' }), modelDraft({ id: 'same' })] }, true, [], '')).toBe(t('modelIdsInvalid'))
  expect(draftFailure({ ...draft, models: [modelDraft({ id: 'one', contextWindow: 50, maxTokens: 100 })] }, true, [], '')).toBe(t('capacityInvalid'))
  expect(draftFailure(draft, true, [], 'key with spaces')).toBe(t('keyInvalid'))
})

it('shows actual model separately from the next selection and changes models through the Session API', async () => {
  render(<ModelControl sessionId="first" eventSeq={1} revision={0} running manage={vi.fn()} />)
  await screen.findByText('gateway / current')
  const picker = screen.getByLabelText(t('nextModel'))
  expect(picker).toHaveProperty('value', JSON.stringify(['gateway', 'next']))
  fireEvent.change(picker, { target: { value: JSON.stringify(['gateway', 'current']) } })
  await waitFor(() =>{  expect(api.selectModel).toHaveBeenCalledWith('first', { provider: 'gateway', model: 'current' }) })
  expect(screen.getByText(t('currentModel'))).toBeTruthy()
})

it('does not install a late projection after changing sessions', async () => {
  let resolveFirst: (value: api.ModelSelectionProjection) => void = () => { throw new Error('Deferred read was not started') }
  vi.mocked(api.sessionModel).mockImplementation(id => id === 'first' ? new Promise((resolve) => { resolveFirst = resolve }) : Promise.resolve({ lastUsed: { provider: 'gateway', model: 'second' }, next: null }))
  const rendered = render(<ModelControl sessionId="first" eventSeq={0} revision={0} running={false} manage={vi.fn()} />)
  rendered.rerender(<ModelControl sessionId="second" eventSeq={0} revision={0} running={false} manage={vi.fn()} />)
  await screen.findByText('gateway / second')
  resolveFirst({ lastUsed: { provider: 'gateway', model: 'stale' }, next: null })
  await waitFor(() =>{  expect(screen.queryByText('gateway / stale')).toBeNull() })
})

it('retains a selection refusal while refreshing a healthy catalog', async () => {
  vi.mocked(api.selectModel).mockRejectedValue(new RpcError('session/model-unavailable', 'endpoint unavailable'))
  render(<ModelControl sessionId="first" eventSeq={1} revision={0} running={false} manage={vi.fn()} />)
  await screen.findByText('gateway / current')
  fireEvent.change(screen.getByLabelText(t('nextModel')), { target: { value: JSON.stringify(['gateway', 'current']) } })
  await screen.findByText('RpcError: endpoint unavailable')
  fireEvent.focus(window)
  await waitFor(() => { expect(api.modelCatalog).toHaveBeenCalledTimes(2) })
  expect(screen.getByText('RpcError: endpoint unavailable')).toBeTruthy()
})

async function openCreation() {
  render(<ModelManager close={vi.fn()} changed={vi.fn()} />)
  await waitFor(() =>{  expect(screen.getByRole('button', { name: t('addModelApi'), exact: true })).toHaveProperty('disabled', false) })
  fireEvent.click(screen.getByRole('button', { name: t('addModelApi'), exact: true }))
  fireEvent.change(screen.getByLabelText(t('providerRoute')), { target: { value: 'custom-gateway' } })
  fireEvent.change(screen.getByLabelText(t('endpoint')), { target: { value: 'http://localhost:8080/v1' } })
  fireEvent.change(screen.getByLabelText(t('protocol')), { target: { value: 'openai-completions' } })
  fireEvent.click(screen.getByRole('button', { name: t('addModel'), exact: true }))
  fireEvent.change(screen.getByLabelText(t('modelId')), { target: { value: 'test-model' } })
}

it('persists only a credential reference in settings and retries a failed key without recreating the provider', async () => {
  vi.mocked(api.storeModelKey).mockRejectedValueOnce(new RpcError('credential/rejected', 'storage unavailable')).mockResolvedValueOnce(undefined)
  await openCreation()
  fireEvent.change(screen.getByLabelText(t('apiKey')), { target: { value: 'synthetic-test-key' } })
  fireEvent.click(screen.getByRole('button', { name: t('saveModelApi') }))
  await screen.findByText(new RegExp(t('modelKeyPending')))
  expect(api.writeModelSettings).toHaveBeenCalledTimes(1)
  const [ns, ops, revision] = vi.mocked(api.writeModelSettings).mock.calls[0]
  expect(ns).toBe('llm-pi-ai')
  expect(revision).toBe(7)
  expect(JSON.stringify(ops)).not.toContain('synthetic-test-key')
  expect(ops).toContainEqual({ op: 'set', path: ['providers', 'custom-gateway', 'apiKeyEnv'], value: 'CUSTOM_GATEWAY_API_KEY' })
  fireEvent.click(screen.getByRole('button', { name: t('retryModelKey') }))
  await screen.findByText(t('modelApiSaved'))
  expect(api.writeModelSettings).toHaveBeenCalledTimes(1)
  expect(api.storeModelKey).toHaveBeenLastCalledWith('CUSTOM_GATEWAY_API_KEY', 'synthetic-test-key')
  expect(api.selectModel).not.toHaveBeenCalled()
})

it('refuses a stale edit and never writes its key', async () => {
  vi.mocked(api.writeModelSettings).mockRejectedValue(new RpcError('settings/conflict', 'changed'))
  await openCreation()
  fireEvent.change(screen.getByLabelText(t('apiKey')), { target: { value: 'synthetic-test-key' } })
  fireEvent.click(screen.getByRole('button', { name: t('saveModelApi') }))
  await screen.findByText(t('settingsConflict'))
  expect(api.storeModelKey).not.toHaveBeenCalled()
})

it('discovers candidates without automatically persisting them', async () => {
  vi.mocked(api.discoverModels).mockResolvedValue([{ id: 'discovered' }])
  await openCreation()
  fireEvent.click(screen.getByRole('button', { name: t('discoverModels') }))
  await screen.findByLabelText('discovereddiscovered')
  expect(api.writeModelSettings).not.toHaveBeenCalled()
  expect(api.storeModelKey).not.toHaveBeenCalled()
})

it('renders a keyless model-change expectation from the retained recorded Session', async () => {
  type RecordedEvent = { type: string; data?: { header?: { config?: ModelSelection } } }
  const events = recordedModelSwitch.trim().split('\n').map(line => JSON.parse(line) as RecordedEvent)
  const models = events.filter(event => event.type === 'request/header').map(event => event.data?.header?.config).filter((value): value is ModelSelection => value !== undefined)
  expect(models.length).toBeGreaterThan(1)
  const actual = models[0]
  const next = models.at(-1)!
  vi.mocked(api.sessionModel).mockResolvedValue({
    lastUsed: { provider: actual.provider, model: actual.model }, next: { provider: next.provider, model: next.model },
  })
  vi.mocked(api.modelCatalog).mockResolvedValue({
    default: actual, failures: [], routableProviders: [actual.provider],
    groups: [{ id: actual.provider, name: actual.provider, models: [
      { id: actual.model, name: actual.model }, { id: next.model, name: next.model },
    ] }],
  })
  const rendered = render(<ModelControl sessionId="recorded-session" eventSeq={1} revision={0} running manage={vi.fn()} />)
  await screen.findByText(`${actual.provider} / ${actual.model}`)
  await expect(rendered.container.innerHTML).toMatchFileSnapshot('./expected/model-selection.html')
})
