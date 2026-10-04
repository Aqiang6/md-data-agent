/**
 * Unary client RPC against the dsh web surface: `POST /api/<method>` with the
 * client-request envelope, unwrapping the result/error union.
 */
import type { HistoryRecord, SessionSummary } from './wire.ts'
import { randomUUID } from '@deepseek-ai/dsh-util-crypto'
import { t } from '../copy.ts'

interface RpcEnvelope {
  type: string
  rpcId: string
  result?: { ok: boolean; value?: unknown; error?: { code: string; message: string } }
}

/** Remote failure code retained for revision-conflict feedback. */
export class RpcError extends Error {
  /** @param code - Host error identifier. @param message - public Host diagnostic. */
  constructor(readonly code: string, message: string) {
    super(message)
    this.name = 'RpcError'
  }
}

/** Send one unary RPC and resolve its business value, throwing on errors. */
export async function rpc<T>(method: string, args: Record<string, unknown>): Promise<T> {
  const response = await fetch(`/api/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ type: 'client-request', rpcId: randomUUID(), method, payload: { args } }),
  })
  if (response.status === 401) throw new Error(t('notLoggedIn'))
  const envelope = (await response.json()) as RpcEnvelope
  if (envelope.type !== 'server-response' || typeof envelope.rpcId !== 'string') {
    throw new Error(`${t('invalidRpcResponse')}: ${method}`)
  }
  const result = envelope.result
  if (result === undefined || !result.ok) {
    throw new RpcError(result?.error?.code ?? 'gateway/internal', result?.error?.message ?? `${t('rpcFailed')}: ${method}`)
  }
  return result.value as T
}

/** List roots with recorded presets; resolve missing cold-session hints without activating agents. */
export async function listSessions(): Promise<{ items: SessionSummary[] }> {
  const result = await rpc<{ items: SessionSummary[] }>('session/list', { _request: {} })
  const items = await Promise.all(result.items.filter(item => item.parentSessionId === undefined).map(async (item) => {
    if (item.projections?.values.agentPreset !== undefined) return item
    const projections = await readProjections(item.sessionId)
    return { ...item, projections: projections ?? undefined }
  }))
  return { items }
}

/** Create one blank session. */
export function createSession(): Promise<{ sessionId: string }> {
  return rpc('session/create', { request: { agentPreset: 'data-agent' } })
}

/**
 * Persist removal from analysis history using the Harness archive operation.
 * @param sessionId - Record to remove; running work is refused by the Host.
 * @returns Complete durable archive set; logs and report files remain intact.
 */
export function deleteAnalysis(sessionId: string): Promise<{ archivedSessionIds: string[] }> {
  return rpc('workspace/archiveSession', { request: { sessionId } })
}

/** Send one user prompt into a session. */
export function prompt(sessionId: string, text: string): Promise<{ accepted: boolean }> {
  return rpc('session/prompt', {
    request: {
      requestId: randomUUID(),
      sessionId,
      mode: 'queue',
      content: [{ type: 'text', text }],
      clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    },
  })
}

/** Cancel the running turn of a session. */
export function cancelSession(sessionId: string): Promise<{ accepted: boolean }> {
  return rpc('session/cancel', { request: { sessionId } })
}

/**
 * Execute one slash command through the host command system (logged as
 * `command/run` + `command/done`, never sent to the model).
 */
export function executeCommand(sessionId: string, line: string): Promise<unknown> {
  return rpc('commands/execute', { agentId: sessionId, line, submittedAttachments: [] })
}

/** Read one backwards journal page. */
export function readPage(
  sessionId: string,
  throughSeq: number,
  beforeSeq?: number,
): Promise<{ records: HistoryRecord[]; hasMore: boolean }> {
  return rpc('session/page', {
    request: { address: { kind: 'session', sessionId }, throughSeq, beforeSeq, maxMessages: 400 },
  })
}

/** Read the current session projections (the `glmDb` picker state rides here). */
export function readProjections(sessionId: string): Promise<SessionSummary['projections'] | null> {
  return rpc('session/projections', { request: { sessionId } })
}
