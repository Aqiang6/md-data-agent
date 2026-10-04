/** Data Agent browser answerer for the existing user-question waterfall. */
import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { AskUserQuestionAnswer, AskUserQuestionItem } from '@deepseek-ai/dsh-user-questions'
import type {} from '@deepseek-ai/dsh-client-connection'
import { z } from 'zod'

interface Pending {
  sessionId: string
  requestId: string
  questions: AskUserQuestionItem[]
  resolve: (answer: AskUserQuestionAnswer) => void
  reject: (error: Error) => void
}

/** Install a cancellable browser answerer; answers enter the normal tool-result journal.
 * @param ctx - authenticated Connection and scoped user-question events.
 */
export function installQuestionsApi(ctx: Context): void {
  const pending = new Map<string, Pending>()
  ctx.on(
    'user-questions/request',
    async (request, next) => {
      if (!request.agent) return await next()
      const sessionId = request.agent.session.id
      const requestId = randomUUID()
      request.signal?.throwIfAborted()
      const completion = Promise.withResolvers<AskUserQuestionAnswer>()
      const abort = (): void => {
        completion.reject(new Error('Question cancelled.'))
      }
      request.signal?.addEventListener('abort', abort, { once: true })
      pending.set(requestId, { sessionId, requestId, questions: request.questions, ...completion })
      try {
        return await completion.promise
      } finally {
        request.signal?.removeEventListener('abort', abort)
        pending.delete(requestId)
      }
    },
    { global: true, prepend: true },
  )
  ctx.effect(
    () => () => {
      for (const item of pending.values()) item.reject(new Error('Question answerer unloaded.'))
      pending.clear()
    },
    'data-agent: pending questions',
  )
  ctx.connection.fetch.register({
    path: '/api/data-agent/questions',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: (request) => {
      const sessionId = new URL(request.url).searchParams.get('sessionId')
      return Promise.resolve(
        Response.json({
          requests: [...pending.values()]
            .filter(item => item.sessionId === sessionId)
            .map(({ resolve: _resolve, reject: _reject, ...item }) => item),
        }),
      )
    },
  })
  ctx.connection.fetch.register({
    path: '/api/data-agent/answer',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = z
          .object({
            sessionId: z.string(),
            requestId: z.string(),
            answers: z.array(
              z.object({
                id: z.string(),
                selected: z.array(z.string()),
                custom: z.string().optional(),
              }),
            ),
          })
          .parse(await request.json())
        const item = pending.get(body.requestId)
        if (!item || item.sessionId !== body.sessionId)
          throw new Error('Question expired or belongs to another session.')
        if (
          body.answers.length !== item.questions.length ||
          new Set(body.answers.map(answer => answer.id)).size !== body.answers.length
        ) {
          throw new Error('Answer every question exactly once.')
        }
        for (const question of item.questions) {
          const answer = body.answers.find(value => value.id === question.id)
          if (!answer || (!answer.selected.length && !answer.custom?.trim()))
            throw new Error('Question answer is empty.')
          if (!question.multiSelect && answer.selected.length > 1) throw new Error('Select at most one option.')
          if (answer.selected.some(label => !question.options?.some(option => option.label === label)))
            throw new Error('Unknown question option.')
        }
        pending.delete(body.requestId)
        item.resolve({
          answers: body.answers.map(answer => ({
            id: answer.id,
            selected: answer.selected,
            ...(answer.custom !== undefined ? { custom: answer.custom } : {}),
          })),
        })
        return Response.json({ accepted: true })
      } catch (error) {
        return Response.json({ error: String(error) }, { status: 400 })
      }
    },
  })
}
