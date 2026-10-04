/** Await replay registration before the SDK handshake. */
import { Service } from '../../../vendor/cordis/lib/index.js'
import * as Replay from '../../../packages/test-support/llm-replay/lib/index.js'
export const inject = ['llm', 'commands']
export async function apply(ctx) {
  await ctx.plugin(Replay, { file: process.env.DSH_SNAPSHOT_FILE, providers: [{ id: 'data-fixture', models: [{ id: 'deepseek-v4-flash' }] }] })
  ctx.on('agent/created', async ({ agent, signal }) => {
    const scope = { version: 2, sources: [{ database: 'shop.db' }], defaultDatabase: 'shop.db' }
    const outcome = await ctx.commands.execute(agent, `/data_scope ${JSON.stringify(scope)}`, [], signal ?? new AbortController().signal)
    if (outcome?.result.kind !== 'success') throw new Error('Fixture database selection failed.')
  }, { global: true })
  class Ready extends Service { constructor(ctx) { super(ctx, 'dataReplayReady') } }
  await ctx.plugin(Ready)
}
