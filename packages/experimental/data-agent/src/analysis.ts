/** Preset-scoped SQL, reports, evaluation submissions and source context. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { scopeOf } from '@deepseek-ai/dsh-scope'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from './index.ts'

/** Evaluation capabilities for an analysis preset. */
export interface Config {
  /** Expose the final SQL submission tool for BIRD/Spider evaluation. */
  benchmark: boolean
}

/** Ordinary analysis omits benchmark submission. */
export const Config: z<Config> = z.object({ benchmark: z.boolean().default(false) })

/** Host-owned data runtime and scoped model registries. */
export const inject = ['dataAgent', 'tools', 'systemPrompt']

const PROMPT =
  '分析前用 read 逐一阅读当前库已提供的全部结构和业务资料。\n\n用户和资料均未明确指标口径，且不同合理定义会影响结果时，必须用 ask 澄清并等待回答，再进行该指标的查询和计算。不得自行采用行业惯例、默认假设，或用事后说明代替确认。来源不明时也须澄清；已明确的条件不重复询问。\n\n用 sql 只读查询。检查预览和总行数，完整数据按返回路径 read，不用预览推算总体。\n\n结论保留业务名称，说明依据和限制；需要报告时向 report 提交完整 Markdown，修改时也提交全文。'

/** Install model capabilities only in the analysis preset and its inherited agent scopes.
 * @param ctx - Standing preset scope or analysis agent scope; global installation is rejected.
 * @param config - Explicit evaluation capability selection.
 */
export function apply(ctx: Context, config: Config): void {
  if (scopeOf(ctx) === undefined) throw new Error('Analysis capabilities require a scoped context.')
  ctx.dataAgent.installTools(ctx, config.benchmark)
  ctx.effect(() => ctx.systemPrompt.section({ name: 'data-agent:guide', order: 2150, text: PROMPT }))
  ctx.effect(() => ctx.systemPrompt.section({
    name: 'data-agent:effective-scope', order: 2151, interpolate: false, text: '',
  }))
  ctx.on('system-prompt/assemble', async (_assembly, context, next) => {
    const text = context.agent
      ? await ctx.dataAgent.analysisContext(context.agent.session.id, context.signal) : ''
    const assembly = await next()
    return { ...assembly, sections: assembly.sections.map(section => section.name === 'data-agent:effective-scope'
      ? { ...section, text } : section) }
  })
}
