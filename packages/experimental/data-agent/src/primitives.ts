/** Read-only file discovery and human input for the analysis preset. */
import type { Context } from '@deepseek-ai/cordis'
import { bindScopeParent, createScope, scopeOf } from '@deepseek-ai/dsh-scope'
import { defineTool } from '@deepseek-ai/dsh-tools'
import * as Files from '@deepseek-ai/dsh-tool-fs'
import * as Search from '@deepseek-ai/dsh-tool-fs-search'
import * as Questions from '@deepseek-ai/dsh-tool-ask-user'
import type {} from '@deepseek-ai/dsh-fs'

/** Services used by the read, search and clarification providers. */
export const inject = ['tools', 'fs', 'subprocess', 'systemPrompt', 'userQuestions']

/** Install read-only general tools with concise names.
 * @param ctx - analysis preset scope; relative paths use the calling Session's cwd.
 */
export async function apply(ctx: Context): Promise<void> {
  const key = {}
  const parent = scopeOf(ctx)
  if (parent) bindScopeParent(key, parent)
  const library = createScope(ctx, key)
  ctx.effect(() => () => library.dispose(), 'analysis: primitive providers')
  await library.ctx.plugin(Files, Files.Config())
  await ctx.plugin(Search, { sampleOverCapGlobResults: false, globToolName: 'find' })
  await library.ctx.plugin(Questions)
  for (const [original, name] of [
    ['read', 'read'], ['ask_user_question', 'ask'],
  ] as const) {
    const tool = library.ctx.tools.get(original, key)
    if (!tool) throw new Error(`Analysis tool is unavailable: ${original}`)
    ctx.effect(() => ctx.tools.register({ ...tool, name }), `analysis: ${name}`)
  }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'ls',
    description: 'List the immediate files and directories at a path.',
    parameters: { path: { type: 'string', description: 'Defaults to the session working directory.' } },
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }],
      presentationMeta: (_args, value) => value,
    },
    async execute(args, exec) {
      const cwd = exec.agent?.session.header.cwd
      const target = await ctx.fs.resolve(args.path ?? '.', {
        ...(cwd === undefined ? {} : { cwd }), signal: exec.signal,
      })
      const entries = (await ctx.fs.listDir(target, exec.signal)).map(entry => ({
        name: entry.name, type: entry.type, path: entry.target.displayPath,
        ...(entry.size === undefined ? {} : { size: entry.size }),
      }))
      return { path: target.displayPath, entries }
    },
  })), 'analysis: ls')
}
