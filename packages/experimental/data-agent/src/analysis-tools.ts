/** Independent SQL execution, file rendering, and explicit final submissions. */
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { DataCore } from './data-core.ts'
import { artifact, report } from './reports.ts'

function session(exec: ToolRunContext) {
  if (!exec.agent) throw new Error('Analysis tools require a session.')
  return exec.agent.session
}

/** Register independent analysis operations alongside the general filesystem tools.
 * @param ctx - tool registry.
 * @param data - connections, results and downloadable files.
 * @param benchmark - Include the final SQL submission used by evaluation presets.
 */
export function installAnalysisTools(ctx: Context, data: DataCore, benchmark: boolean): void {
  const output = {
    schema: { type: 'json' } as const,
    render: (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }],
    presentationMeta: (_args: unknown, value: import('@deepseek-ai/dsh-util-values').JsonValue) => value,
  }
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'sql',
    description: 'Run a read-only SQL statement. Returns a row preview and a file containing the complete result.',
    parameters: {
      database: { type: 'string', description: 'Source from the session context; defaults to the selected database.' },
      sql: { type: 'string', required: true },
      params: { type: 'array', items: { type: 'json' }, description: 'Positional parameter values.' },
      timeoutMs: { type: 'integer', description: 'Execution timeout in milliseconds; 0 disables the timeout.' },
    },
    output,
    async execute(args, exec) {
      const owner = session(exec)
      await data.restoreScope(owner.id)
      const database = args.database ?? data.defaultDatabase(owner.id)
      if (!database) throw new Error('Choose a database or supply database.')
      const result = await data.executeSql(owner.id, database, args.sql,
        z.array(z.union([z.string(), z.number(), z.boolean(), z.null()])).parse(args.params ?? []),
        exec.signal, args.timeoutMs)
      return { ...result, reading: 'Inspect the rows before concluding. Use read for the complete result file; use sql for further calculations instead of extrapolating from the preview.' }
    },
  })), 'analysis: sql')
  ctx.effect(() => ctx.tools.register(defineTool({
    name: 'report',
    description: 'Create a report from Markdown content as downloadable Markdown, HTML or PDF. Each call saves a new revision.',
    parameters: {
      markdown: { type: 'string', required: true, description: 'Complete report content, including verified values and tables.' },
      title: { type: 'string', required: true },
      formats: { type: 'array', required: true, items: { type: 'string', enum: ['md', 'html', 'pdf'] } },
      language: { type: 'string' },
    },
    output,
    async execute(args, exec) {
      const owner = session(exec)
      return z.json().parse(JSON.parse(JSON.stringify(await report(data, owner.id, args.title, args.markdown, [], args.formats,
        exec.signal, args.language ? { language: args.language } : {}))))
    },
  })), 'analysis: report')
  if (benchmark) ctx.effect(() => ctx.tools.register(defineTool({
    name: 'benchmark',
    description: 'Submit the verified final SQL for BIRD/Spider benchmark evaluation, with an optional answer. This records the prediction; it does not score it.',
    parameters: {
      sql: { type: 'string', required: true, description: 'Final SQL for the evaluation case.' },
      answer: { type: 'string' },
    },
    output,
    async execute(args, exec) {
      const owner = session(exec)
      return z.json().parse(JSON.parse(JSON.stringify({ ...args,
        submission: await artifact(data, owner.id, 'submission.json', JSON.stringify(args)) })))
    },
  })), 'analysis: benchmark')
}
