/** SDK creation binds the same preset registry used by Web before publication. */
import { afterEach, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type {
  GenerateOptions,
  LlmResolvedModelInfo,
  StreamChunk,
} from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { HarnessSdkJsonRpcServer } from '../src/index.ts'

const contexts: Context[] = []
afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
})

class Model extends LlmAdapter {
  requests: GenerateOptions[] = []
  override resolveModel(
    provider: string,
    id: string,
  ): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id,
      name: id,
      inputModalities: ['text'],
    })
  }
  async *stream(request: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(request)
    yield {
      type: 'block-end',
      index: 0,
      block: { type: 'text', text: 'Analysis complete.' },
    }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

async function setup(defaultId: string) {
  const ctx = new Context()
  contexts.push(ctx)
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(Loader)
  ctx.loader.builtins['analysis-prompt'] = {
    inject: ['systemPrompt'],
    apply(child: Context) {
      child.effect(() =>
        child.systemPrompt.section({
          name: 'analysis:persona',
          order: 1,
          text: 'You analyze verified data.',
        }),
      )
    },
  }
  await ctx.plugin(Presets, { default: defaultId })
  await ctx.agentPresets.register({
    id: 'analysis',
    plugins: [{ name: 'cordis:analysis-prompt' }],
  })
  const model = new Model()
  ctx.llm.registerAdapter(['fixture'], model)
  const server = new HarnessSdkJsonRpcServer(ctx, {
    notify() {},
    request: async () => {
      throw new Error('SDK runtime must not send a host request here.')
    },
  })
  await server.initialize({
    cwd: process.cwd(),
    provider: 'fixture',
    model: 'scripted',
  })
  return { ctx, server, model }
}

it('records the default preset and composes it before agent/created and the first model request', async () => {
  const { ctx, server, model } = await setup('analysis')
  const publications: Array<string | undefined> = []
  ctx.on('agent/created', ({ agent }) => {
    publications.push(ctx.agentPresets.composedPreset(agent.ctx))
  })
  await server.prompt({
    sessionId: 'sdk-analysis',
    contentBlocks: [{ type: 'text', text: 'Analyze data.' }],
  })
  const agent = ctx.agents.get(SessionId('sdk-analysis'))
  expect(agent).toBeDefined()
  await agent!.whenIdle()
  expect(publications).toEqual(['analysis'])
  expect(agent!.session.header.agentPreset).toBe('analysis')
  expect(JSON.stringify(model.requests[0])).toContain(
    'You analyze verified data.',
  )
  await server.shutdown()
})

it('rejects a missing default without publishing an Agent or dispatching inference', async () => {
  const { ctx, server, model } = await setup('missing')
  await expect(
    server.prompt({
      sessionId: 'missing-preset',
      contentBlocks: [{ type: 'text', text: 'Analyze.' }],
    }),
  ).rejects.toThrow('Unknown agent preset')
  expect(ctx.agents.get(SessionId('missing-preset'))).toBeUndefined()
  expect(model.requests).toEqual([])
  await server.shutdown()
})
