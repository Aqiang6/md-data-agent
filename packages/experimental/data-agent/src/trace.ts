/** Read-only harness request observations, independent of provider HTTP encoding. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { isAgentLoopRequest } from '@deepseek-ai/dsh-llm'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-session'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-query'
import type { DataCore } from './data-core.ts'
import { RequestId } from './brand.ts'
import { z } from 'zod'

const requestSchema = z.object({
  version: z.literal(1),
  scope: z.literal('harness-request'),
  request: z.looseObject({
    messages: z.array(z.looseObject({ role: z.string(), content: z.unknown() })),
    tools: z.unknown().optional(),
  }),
  header: z.unknown(),
  inputThroughSeq: z.number().int(),
})
/** Immutable request snapshot and digest. */
export interface RequestSnapshot {
  snapshot: z.infer<typeof requestSchema>
  sha256: string
}
/** Complete request section, reconstructed from an immutable observation. */
export interface RequestSection {
  requestId: RequestId
  scope: string
  inputThroughSeq: number
  sha256: string
  raw: string
}
/** Exact request section page. */
export interface RequestPage extends RequestSection {
  offset: number
  nextOffset: number | null
  totalChars: number
}

/** Read and validate an immutable harness request snapshot.
 * @param data - evidence storage.
 * @param sessionId - snapshot owner.
 * @param requestId - logged identifier.
 * @returns request and file digest for comparison with the locator event.
 */
export async function readRequest(data: DataCore, sessionId: string, requestId: string): Promise<RequestSnapshot> {
  if (!/^[a-f0-9-]{36}$/u.test(requestId)) throw new Error('Invalid request identifier.')
  const raw = await readFile(join(data.root(sessionId), 'requests', `${requestId}.json`), 'utf8')
  return { snapshot: requestSchema.parse(JSON.parse(raw)), sha256: createHash('sha256').update(raw).digest('hex') }
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Actual harness request locator; does not affect message reconstruction. */
    'data-agent/request': {
      requestId: RequestId
      turn: number
      step: number
      attempt: number
      inputThroughSeq: number
      sha256: string
    }
    /** Model attempt settlement; tools run outside this interval. */
    'data-agent/request-end': { requestId: RequestId; status: string; usage?: TokenUsage; finish?: string; error?: string }
  }
}

/** Record every actual loop dispatch, including retries and cancellation.
 * @param ctx - provider and Session services.
 * @param data - evidence storage.
 */
export function installTrace(ctx: Context, data: DataCore): void {
  const positions = new WeakMap<Session, { turn: number; step: number; attempt: number }>()
  const observe = (session: Session, event: SessionEvent): void => {
    if (event.type === 'step/start') {
      positions.set(session, { turn: event.data.turn, step: event.data.step, attempt: 0 })
    } else if (event.type === 'data-agent/request') {
      const position = positions.get(session)
      if (position?.turn === event.data.turn && position.step === event.data.step)
        position.attempt = event.data.attempt
    }
  }
  ctx.on('session/event', observe, { global: true })
  ctx.on(
    'llm/stream',
    async function* (options, next) {
      if (!isAgentLoopRequest(options) || options.sessionId === undefined) {
        yield* next()
        return
      }
      const session = ctx.sessions.get(options.sessionId)
      if (session === undefined) throw new Error('Request trace cannot locate its owning Session.')
      const inputThroughSeq = Number(session.seq) - 1
      if (!positions.has(session)) {
        for (const event of (await ctx.sessionQuery.readSession(session.id)).events)
          if (event.seq <= inputThroughSeq) observe(session, event)
      }
      const position = positions.get(session)
      if (position === undefined) throw new Error('Request trace has no active step.')
      const requestId = RequestId(randomUUID())
      const attempt = position.attempt + 1
      const { signal: _signal, ...request } = options
      const serialized = JSON.stringify({
        version: 1,
        scope: 'harness-request',
        request,
        header: session.requestHeader(),
        inputThroughSeq,
      })
      const directory = join(data.root(session.id), 'requests')
      await mkdir(directory, { recursive: true })
      await writeFile(join(directory, `${requestId}.json`), serialized, { flag: 'wx' })
      session.append(
        'data-agent/request',
        {
          requestId,
          turn: position.turn,
          step: position.step,
          attempt,
          inputThroughSeq,
          sha256: createHash('sha256').update(serialized).digest('hex'),
        },
        { ignorable: true },
      )
      let usage: TokenUsage | undefined
      let finish: string | undefined
      let finishKind: string | undefined
      let failure: string | undefined
      try {
        for await (const chunk of next()) {
          if (chunk.type === 'usage') usage = chunk.usage
          if (chunk.type === 'finish') {
            finish = JSON.stringify(chunk.reason)
            finishKind = chunk.reason.kind
            if (chunk.reason.kind === 'error' || chunk.reason.kind === 'aborted') failure = chunk.reason.failure.message
          }
          yield chunk
        }
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error)
        throw error
      } finally {
        session.append(
          'data-agent/request-end',
          {
            requestId,
            status:
              options.signal?.aborted || finishKind === 'aborted'
                ? 'cancelled'
                : failure !== undefined || finishKind === 'error'
                  ? 'failed'
                  : 'completed',
            ...(usage ? { usage } : {}),
            ...(finish ? { finish } : {}),
            ...(failure ? { error: failure } : {}),
          },
          { ignorable: true },
        )
      }
    },
    { global: true, prepend: true },
  )
}

/** Read complete immutable request content for viewing or download.
 * @param data - evidence storage.
 * @param sessionId - owning Session.
 * @param requestId - logged request identifier.
 * @param section - system, context, tools, info, or raw source.
 * @returns exact section text, observation digest, and input-log position.
 */
export async function requestSection(
  data: DataCore,
  sessionId: string,
  requestId: string,
  section = 'raw',
): Promise<RequestSection> {
  const { snapshot: parsed, sha256 } = await readRequest(data, sessionId, requestId)
  const text = (content: unknown): string => {
    if (typeof content === 'string') return content
    const blocks = z.array(z.unknown()).safeParse(content)
    if (!blocks.success) return JSON.stringify(content, null, 2)
    return blocks.data
      .map((block) => {
        const value = z.object({ text: z.string() }).safeParse(block)
        return value.success ? value.data.text : JSON.stringify(block, null, 2)
      })
      .join('\n')
  }
  let json: string
  switch (section) {
    case 'system':
      json = parsed.request.messages
        .filter(message => message.role === 'system')
        .map(message => text(message.content))
        .join('\n\n')
      break
    case 'context':
      json = parsed.request.messages
        .map((message, index) => `## ${index + 1}. ${message.role}\n\n${text(message.content)}`)
        .join('\n\n')
      break
    case 'tools':
      json = JSON.stringify(parsed.request.tools ?? [], null, 2)
      break
    case 'info': {
      const { messages: _messages, tools: _tools, ...info } = parsed.request
      json = JSON.stringify({ ...info, header: parsed.header, inputThroughSeq: parsed.inputThroughSeq }, null, 2)
      break
    }
    case 'raw':
      json = JSON.stringify(parsed, null, 2)
      break
    default:
      throw new Error('Unknown request detail section.')
  }
  return {
    requestId: RequestId(requestId),
    scope: 'harness-request',
    inputThroughSeq: parsed.inputThroughSeq,
    sha256,
    raw: json,
  }
}

/** Read a bounded page without omitting any characters from the full section.
 * @param data - evidence storage and configured page size.
 * @param sessionId - snapshot owner.
 * @param requestId - logged request identifier.
 * @param offset - UTF-16 character cursor, starting at zero.
 * @param section - system, context, tools, info, or raw.
 * @returns exact page and next cursor, or null at the end.
 */
export async function requestDetail(
  data: DataCore,
  sessionId: string,
  requestId: string,
  offset: number,
  section = 'raw',
): Promise<RequestPage> {
  if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid request cursor.')
  const complete = await requestSection(data, sessionId, requestId, section)
  if (offset > complete.raw.length) throw new Error('Request cursor exceeds section length.')
  const end = Math.min(complete.raw.length, offset + data.config.documentPageChars)
  return {
    ...complete,
    raw: complete.raw.slice(offset, end),
    offset,
    nextOffset: end < complete.raw.length ? end : null,
    totalChars: complete.raw.length,
  }
}
