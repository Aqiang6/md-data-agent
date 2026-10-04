/**
 * Data Agent database picker, browser half: the DbDock entry in the
 * conversation.input.dock strip over the `glmDb` session projection.
 * @module @deepseek-ai/dsh-experimental-data-agent/client
 */
import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: pulls the renderer-owned slots service.
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the Session standard useProjection seat.
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
// Type-only: pulls the Conversation service and the input-dock slot row.
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
// Type-only: the `glmDb` SessionProjectionMap key merge (single source, src/types.ts).
import type {} from '../types.ts'
import { DbDock } from './DbBar.tsx'
import { en, NS, zh, type DataAgentKey } from './locales.ts'

export { DbDock } from './DbBar.tsx'
export type { DataAgentKey } from './locales.ts'
export type { DataAgentProjection } from '../types.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Data Agent database dock copy. */
    dataAgent: DataAgentKey
  }
}

/** Required services for the dock registration and its copy. */
export const inject = ['slots', 'locale']

/**
 * Client plugin body: register the database picker dock entry.
 * @param ctx - client root context.
 */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'data-agent: dictionaries')
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock',
    id: 'data-agent',
    order: 20,
    locale: NS,
  }, DbDock))
}
