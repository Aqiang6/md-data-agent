/** Session database selection restored only from successful human commands. */
import { z } from 'zod'
import type { SessionEvent } from '@deepseek-ai/dsh-session'

/** Validated explicit scope; an empty source list disables business queries. */
export const dataScopeSchema = z.strictObject({
  version: z.literal(2),
  sources: z.array(z.strictObject({ database: z.string().min(1) })),
  defaultDatabase: z.string().nullable(),
})
/** Session-effective sources with all tables available; null scope keeps legacy discovery. */
export type DataScope = z.infer<typeof dataScopeSchema>

const savedScopeSchema = z.union([dataScopeSchema, z.object({
  version: z.literal(1),
  sources: z.array(z.object({ database: z.string().min(1), tables: z.array(z.string().min(1)) })),
  defaultDatabase: z.string().nullable(),
}).transform(({ sources, defaultDatabase }): DataScope => ({
  version: 2, sources: sources.map(({ database }) => ({ database })), defaultDatabase,
}))])

/** Restore the last successful scope, ignoring failed and interrupted commands.
 * Historical table lists do not restrict the restored databases.
 * @param events - chronological raw session records, including inherited records.
 * @returns explicit selection, or null when no selection was saved.
 */
export function foldDataScope(events: readonly SessionEvent[]): DataScope | null {
  const commands = new Map<string, { name: string; args: string }>()
  let scope: DataScope | null = null
  for (const event of events) {
    if (event.type === 'command/run' && ['data_scope', 'db'].includes(event.data.name))
      commands.set(event.data.commandId, { name: event.data.name, args: event.data.args ?? '' })
    if (event.type !== 'command/done' || event.data.kind !== 'success') continue
    const command = commands.get(event.data.commandId)
    if (!command) continue
    if (command.name === 'db') {
      const input = command.args.trim()
      if (scope !== null && input && input.toLowerCase() !== 'list')
        scope = Object.assign({}, scope, { defaultDatabase: input.toLowerCase() === 'clear' ? null : input })
      continue
    }
    const text = event.data.text ?? ''
    if (!text.startsWith('data-agent-scope:'))
      throw new Error('Saved data scope is missing its canonical result.')
    scope = savedScopeSchema.parse(JSON.parse(text.slice('data-agent-scope:'.length)))
  }
  return scope
}

/** Restore a legacy picker selection from successful /db commands only.
 * @param events - chronological session records.
 * @returns selected source, null after clear, or undefined without a picker command.
 */
export function foldDefaultDatabase(events: readonly SessionEvent[]): string | null | undefined {
  const commands = new Map<string, string>()
  let selected: string | null | undefined
  for (const event of events) {
    if (event.type === 'command/run' && event.data.name === 'db') commands.set(event.data.commandId, (event.data.args ?? '').trim())
    if (event.type !== 'command/done' || event.data.kind !== 'success') continue
    const input = commands.get(event.data.commandId)
    if (input && input.toLowerCase() !== 'list') selected = input.toLowerCase() === 'clear' ? null : input
  }
  return selected
}
