/** Analysis-only prompt and global tool selection, owned by the active preset revision. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'

/** Explicit model and executable capabilities supplied by the analysis preset. */
export interface Config {
  /** Tool names allowed for this preset, including its scoped interaction tools. */
  tools: string[]
}

/** Unknown tool names fail when the preset assembles its available capabilities. */
export const Config: z<Config> = z.object({ tools: z.array(z.string()).required() })

/** Registries inherited by the preset's standing scope. */
export const inject = ['tools', 'systemPrompt']

/** Install analysis restrictions without altering other presets or their historical requests.
 * @param ctx - Standing preset scope; global installation is rejected.
 * @param config - Explicit model and executable capabilities.
 */
export function apply(ctx: Context, config: Config): void {
  if (scopeOf(ctx) === undefined) throw new Error('Analysis policy requires a scoped context.')
  const allowed = new Set(config.tools)
  const redundantGuides = new Set(['tool:read', 'tool:grep', 'tool:find', 'tool:glob', 'context:file-reference'])
  ctx.effect(() => ctx.tools.guard(exec => allowed.has(exec.name)
    ? undefined : 'This tool is disabled by the analysis preset.'))
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const assembly = await next()
    const available = new Set(assembly.tools.map(tool => tool.name))
    const unknown = config.tools.filter(name => !available.has(name))
    if (unknown.length) throw new Error(`Analysis preset names unknown tool(s): ${unknown.join(', ')}`)
    return { ...assembly, tools: assembly.tools.filter(tool => allowed.has(tool.name)),
      sections: assembly.sections.filter(section => !redundantGuides.has(section.name)
        && (!section.name.startsWith('tool:') || allowed.has(section.name.slice(5)))) }
  })
  for (const [name, position] of [
    ['harness:identity', 'HARNESS_IDENTITY'],
    ['harness:source', 'HARNESS_SOURCE'],
    ['app:web-surface', 'WEB_SURFACE'],
    ['ui:deliverable-file-references', 'DELIVERABLE_FILE_REFERENCES'],
  ] as const) {
    ctx.effect(() => ctx.systemPrompt.section({
      name, order: ctx.systemPrompt.getSectionOrder(position), text: '',
    }))
  }
}
