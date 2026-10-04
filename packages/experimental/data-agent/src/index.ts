/** Host-owned Data Agent runtime, evidence recording and optional Web presentation. */
import type { Context } from '@deepseek-ai/cordis'
import { z } from 'zod'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-session-projection'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-session-query'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-credentials'
import { SessionId } from '@deepseek-ai/dsh-session'
import { foldDataScope, foldDefaultDatabase } from './data-scope.ts'
import type { DataScope } from './data-scope.ts'
import { Config } from './config.ts'
import { DataCore } from './data-core.ts'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import { installAnalysisTools } from './analysis-tools.ts'
import { listDatabases } from './databases.ts'
import { installTrace } from './trace.ts'
import { installDataApi } from './web-api.ts'
import { installQuestionsApi } from './questions-api.ts'
import { registerUiSurface, resolveUiDist, uiIndexExists } from './ui-server.ts'
import type { DataAgentProjection, DataAgentRuntime } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host capabilities for installing analysis tools and publishing source context. */
    dataAgent: DataAgentRuntime
  }
}

export { Config, DataCore }
export * from './brand.ts'
export type * from './types.ts'
export type * from './trace.ts'
export const name = 'data-agent'
export const inject = [
  'commands',
  'sessionProjections',
  'sessions',
  'sessionQuery',
  'llm',
]

const projectionSchema = z.object({ databases: z.array(z.string()), selected: z.string().nullable() })
/** Install the same data capability in Web, SDK, and evaluation profiles.
 * @param ctx - Session, commands, inference recording and optional Web services.
 * @param config - validated deployment settings.
 */
export function apply(ctx: Context, config: Config): void {
  const legacyDefaults = new Map<string, string | null>()
  const loadScope = async (sessionId: string): Promise<DataScope | null> => {
    const visited = new Set<string>()
    let current: string | undefined = sessionId
    let selected: string | null | undefined
    while (current) {
      if (visited.has(current)) throw new Error('Cyclic data selection ancestry.')
      visited.add(current)
      const snapshot = await ctx.sessionQuery.readSession(SessionId(current))
      if (selected === undefined) selected = foldDefaultDatabase(snapshot.events)
      const scope = foldDataScope(snapshot.events)
      if (scope) return scope
      current = snapshot.session.parentSession
    }
    legacyDefaults.set(sessionId, selected ?? null)
    return null
  }
  const data = new DataCore(config, () => ctx.get('credentials'), loadScope, sessionId => legacyDefaults.get(sessionId) ?? null)
  const runtime: DataAgentRuntime = {
    installTools(owner, benchmark) {
      if (scopeOf(owner) === undefined) throw new Error('Analysis capabilities require a scoped context.')
      installAnalysisTools(owner, data, benchmark)
    },
    analysisContext: (sessionId, signal) => data.analysisContext(sessionId, signal),
  }
  ctx.provide('dataAgent', runtime)

  ctx.on(
    'session/event',
    (session, event) => {
      if (event.type === 'command/done') data.forgetScope(session.id)
    },
    { global: true },
  )
  ctx.effect(
    () =>
      ctx.sessionProjections.register<'glmDb', DataAgentProjection>({
        key: 'glmDb',
        stateSchema: projectionSchema,
        init: () => ({ databases: listDatabases(config), selected: null }),
        apply: (state, event) => {
          if (event.type !== 'command/run' || event.data.name !== 'db') return state
          const input = (event.data.args ?? '').trim()
          if (input.toLowerCase() === 'clear') return { databases: listDatabases(config), selected: null }
          return listDatabases(config).includes(input)
            ? { databases: listDatabases(config), selected: input }
            : state
        },
        wire: { viewSchema: projectionSchema, view: state => state },
        stateVersion: 1,
      }),
    'data-agent: selection projection',
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        definitionId: CommandDefinitionId('@deepseek-ai/dsh-experimental-data-agent'),
        name: 'db',
        description: '选择数据库',
        input: { hint: '[list | clear | name]' },
        handler: async (invocation) => {
          const input = invocation.rawInput.trim()
          await data.restoreScope(invocation.agent.session.id)
          const scope = data.scope(invocation.agent.session.id)
          const databases = (await data.catalog.list())
            .map(source => source.id)
            .filter(id => !scope || scope.sources.some(source => source.database === id))
          if (input === '' || input.toLowerCase() === 'list')
            return { kind: 'success', text: databases.join('\n') }
          if (invocation.agent.status === 'running')
            return { kind: 'error', text: 'Stop the running analysis before changing its default database.' }
          if (input.toLowerCase() === 'clear') {
            return { kind: 'success', text: '已清除数据库选择。' }
          }
          return databases.includes(input)
            ? { kind: 'success', text: `已选择数据库：${input}` }
            : { kind: 'error', text: `数据库不存在：${input}` }
        },
      }),
    'data-agent: db command',
  )

  ctx.effect(
    () =>
      ctx.commands.register({
        definitionId: CommandDefinitionId('@deepseek-ai/dsh-experimental-data-agent/scope'),
        name: 'data_scope',
        description: '设置分析会话生效的数据库',
        input: { hint: '<JSON>' },
        handler: async (invocation) => {
          const running = () => invocation.agent.status === 'running'
          if (running())
            return { kind: 'error', text: 'Stop the running analysis before changing its data scope.' }
          const scope = await data.validateScope(
            invocation.agent.session.id,
            JSON.parse(invocation.rawInput),
            invocation.signal,
          )
          if (running())
            return { kind: 'error', text: 'Stop the running analysis before changing its data scope.' }
          return { kind: 'success', text: `data-agent-scope:${JSON.stringify(scope)}` }
        },
      }),
    'data-agent: scope command',
  )

  installTrace(ctx, data)
  ctx.inject(['connection'], (web) => {
    installDataApi(web, data)
    if (config.uiDist !== '') installQuestionsApi(web)
  })
  if (config.uiDist !== '')
    ctx.inject(['webServer', 'connection'], (web) => {
      const root = resolveUiDist(config.uiDist)
      if (uiIndexExists(root))
        web.effect(
          () =>
            registerUiSurface(
              web.webServer,
              root,
              () => listDatabases(config),
              req => web.connection.requestRejection(req),
            ),
          'data-agent: Web shell',
        )
      else ctx.logger.warn(`Data Agent UI is not built at ${config.uiDist}.`)
    })
}
