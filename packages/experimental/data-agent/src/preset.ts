/** Shared analysis composition for Web, SDK, and evaluation Agents. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent-preset-registry'

/** Deployment identity and the concise analysis persona. */
export interface Config {
  /** Session preset identity. */
  id: string
  /** Name displayed by preset discovery. */
  name: string
  /** Preset ordering in discovery. */
  order: number
  /** Concise analysis persona; evidence rules come from the scoped analysis plugin. */
  persona: string
  /** Global capabilities exposed to analysis agents; scoped clarification remains available. */
  tools: string[]
  /** Enable scoped subagents and workflow orchestration; disabled for ordinary analysis. */
  delegation: boolean
  /** Expose explicit final SQL submission for benchmark evaluation. */
  benchmark: boolean
}

/** Runtime configuration for the shared analysis preset. */
export const Config: z<Config> = z.object({
  id: z.string().default('data-agent'),
  name: z.string().default('Data Agent'),
  order: z.number().default(0),
  persona: z
    .string()
    .default(
      '你是数据分析助手。',
    ),
  tools: z.array(z.string()).default([
    'read', 'grep', 'find', 'ls', 'sql', 'report',
  ]),
  delegation: z.boolean().default(false),
  benchmark: z.boolean().default(false),
})

/** Services needed to publish the analysis preset. */
export const inject = ['agentPresets']

/** Register one analysis preset; the Host supplies the data runtime and request recording.
 * @param ctx - Preset registry owned by the application profile.
 * @param config - Validated identity, display order, and persona.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() =>
    ctx.agentPresets.register({
      id: config.id,
      name: config.name,
      order: config.order,
      plugins: [
        {
          id: 'analysis',
          name: '@deepseek-ai/dsh-experimental-data-agent/analysis',
          config: { benchmark: config.benchmark },
        },
        {
          id: 'analysis-policy',
          name: '@deepseek-ai/dsh-experimental-data-agent/policy',
          config: { tools: [...config.tools, 'ask', ...(config.benchmark ? ['benchmark'] : []), ...(config.delegation ? ['subagent', 'workflow'] : [])] },
        },
        {
          id: 'persona',
          name: '@deepseek-ai/dsh-persona',
          config: { prefix: config.persona, includeRuntimeContext: false },
        },
        { id: 'primitives', name: '@deepseek-ai/dsh-experimental-data-agent/primitives' },
        {
          id: 'compaction',
          name: 'cordis:group',
          group: true,
          isolate: { compaction: true },
          config: [
            {
              id: 'compaction-basic',
              name: '@deepseek-ai/dsh-compaction-basic',
            },
          ],
        },
        ...(config.delegation ? [{
          id: 'delegation',
          name: 'cordis:group',
          group: true,
          isolate: { workflowEngine: true as const },
          config: [
            {
              id: 'tool-subagent',
              name: '@deepseek-ai/dsh-tool-subagent',
              config: {
                provider: 'spawn',
                toolName: 'subagent',
                backgroundMode: 'one-shot',
              },
            },
            {
              id: 'workflow-ptc',
              name: '@deepseek-ai/dsh-workflow-ptc',
              config: { provider: 'spawn' },
            },
            { id: 'tool-workflow', name: '@deepseek-ai/dsh-tool-workflow' },
          ],
        }] : []),
      ],
    }),
  )
}
