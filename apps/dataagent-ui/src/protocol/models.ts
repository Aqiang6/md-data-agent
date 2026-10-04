/** Model configuration uses the Harness catalog, settings and write-only credential RPCs. */
import type {
  CredentialInfo, LlmConfigurableProvider, LlmDiscoveredModel, LlmModelDiscoveryRequest,
  ModelCatalog, ModelSelection, ModelSelectionProjection, SessionProjectionsValue,
  SettingsDescribeValue, SettingsNamespaceView, SettingsPathOpView,
} from '@deepseek-ai/dsh-api-remotes/client'
import { rpc } from './api.ts'

export type {
  CredentialInfo, LlmConfigurableProvider, LlmDiscoveredModel, ModelCatalog,
  ModelSelection, ModelSelectionProjection, SettingsNamespaceView, SettingsPathOpView,
}

/** Read the adapter-owned model catalog and deployment default. */
export const modelCatalog = (): Promise<ModelCatalog> => rpc('session/modelCatalog', {})

/** Read redacted layered configuration; never reads API keys. */
export const modelSettings = (): Promise<SettingsDescribeValue> => rpc('settings/describe', {})

/** Read adapter-owned configuration addresses, including dormant providers. */
export const modelProviders = (): Promise<LlmConfigurableProvider[]> => rpc('llm/listConfigurableProviders', {})

/** Describe key availability and writability without returning secrets. */
export const credentialInfo = (refs: string[]): Promise<Record<string, CredentialInfo>> =>
  rpc('credentials/describe', { refs })

/** Store a new key on the Host; callers clear their form value after success. */
export const storeModelKey = (ref: string, value: string): Promise<void> => rpc('credentials/set', { ref, value })

/** Apply narrow settings edits against the revision the editor opened. */
export const writeModelSettings = (ns: string, ops: SettingsPathOpView[], expectedRevision: number): Promise<SettingsNamespaceView> =>
  rpc('settings/mutate', { ns, ops, expectedRevision })

/** Interrogate a draft through the existing adapter; does not persist configuration. */
export const discoverModels = (settingsNs: string, request: LlmModelDiscoveryRequest): Promise<LlmDiscoveredModel[]> =>
  rpc('llm/discoverModels', { settingsNs, request })

/** Read the durable actual and next-request model selections for one session. */
export async function sessionModel(sessionId: string): Promise<ModelSelectionProjection | undefined> {
  const baseline = await rpc<SessionProjectionsValue>('session/projections', { request: { sessionId } })
  return baseline?.values.modelSelection
}

/** Select a session model through Harness validation and durable logging. */
export const selectModel = (sessionId: string, selection: ModelSelection): Promise<{ selected: ModelSelection }> =>
  rpc('session/selectModel', { request: { sessionId, ...selection } })
