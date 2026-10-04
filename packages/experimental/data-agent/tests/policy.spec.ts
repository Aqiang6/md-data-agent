/** Preset-owned capabilities, prompt inheritance and restoration without changing unrelated agents. */
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Projections from '@deepseek-ai/dsh-session-projection'
import Presets from '@deepseek-ai/dsh-agent-preset-registry'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import Tools, { defineTool } from '@deepseek-ai/dsh-tools'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { bindScopeParent, createScope } from '@deepseek-ai/dsh-scope'
import { expect, it, vi } from 'vitest'
import * as Policy from '../src/policy.ts'
import * as Preset from '../src/preset.ts'

it('applies the minimal selection to roots and inherited children, preserving evidence rules and restoring other presets', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    for (const name of ['list_sources', 'bash']) ctx.effect(() => ctx.tools.register(defineTool({
      name, description: name, parameters: {}, output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      async execute() { return name },
    })))
    for (const name of ['harness:source', 'app:web-surface', 'ui:deliverable-file-references',
      'tool:read', 'tool:grep', 'tool:find', 'tool:glob', 'context:file-reference', 'tool:bash', 'tool:write', 'tool:goal'])
      ctx.effect(() => ctx.systemPrompt.section({ name, order: 100, text: `Generic ${name}` }))
    ctx.effect(() => ctx.systemPrompt.section({ name: 'data-agent:guide', order: 2150, text: 'Read versioned MD. Respect enabled tables. Submit evidence.' }))
    const presetKey = { id: 'analysis-preset' } as Agent
    const childKey = { id: 'analysis-child' } as Agent
    const scope = createScope(ctx, presetKey)
    createScope(ctx, childKey)
    bindScopeParent(childKey, presetKey)
    await scope.ctx.plugin(Object.assign((inner: Context) => {
      inner.effect(() => inner.tools.register(defineTool({
        name: 'ask_user_question', description: 'Scoped clarification', parameters: {},
        output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
        async execute() { return 'clarified' },
      })))
    }, { inject: ['tools'] }))
    const policy = await scope.ctx.plugin(Policy, { tools: ['list_sources', 'ask_user_question'] })
    const parent = await ctx.systemPrompt.assemble({ scope: presetKey })
    expect(parent.tools.map(tool => tool.name)).toEqual(['ask_user_question', 'list_sources'])
    expect(renderPrompt(parent)).toBe('Read versioned MD. Respect enabled tables. Submit evidence.')
    const inherited = await ctx.systemPrompt.assemble({ scope: childKey })
    expect(renderPrompt(inherited)).toBe(renderPrompt(parent))
    expect(inherited.tools).toEqual(parent.tools)
    for (const agent of [presetKey, childKey]) {
      const execute = (name: string) => ctx.tools.execute({
        signal: new AbortController().signal, callId: ToolCallId(`policy-${name}`), name, arguments: {}, agent,
      })
      expect((await execute('ask_user_question')).content).toEqual([{ type: 'text', text: 'clarified' }])
      expect((await execute('list_sources')).isError).not.toBe(true)
      expect(await execute('bash')).toMatchObject({
        isError: true, content: [{ type: 'text', text: 'Error: This tool is disabled by the analysis preset.' }],
      })
    }
    const generic = await ctx.systemPrompt.assemble()
    expect(generic.tools.map(tool => tool.name)).toEqual(['bash', 'list_sources'])
    expect(renderPrompt(generic)).toContain('Generic app:web-surface')
    expect(renderPrompt(generic)).toContain('Generic context:file-reference')
    await policy.dispose()
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: childKey }))).toContain('powered by DeepSeek Harness')
    expect(renderPrompt(await ctx.systemPrompt.assemble({ scope: childKey }))).toContain('Generic tool:find')
    expect((await ctx.systemPrompt.assemble({ scope: childKey })).tools.map(tool => tool.name)).toEqual(['ask_user_question', 'bash', 'list_sources'])
    expect((await ctx.tools.execute({
      signal: new AbortController().signal, callId: ToolCallId('restored'), name: 'bash', arguments: {}, agent: childKey,
    })).isError).not.toBe(true)
  } finally { await ctx.fiber.dispose() }
})

it('rejects unknown capabilities and global policy installation', async () => {
  const ctx = new Context()
  try {
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(Tools)
    await expect(ctx.plugin(Policy, { tools: [] })).rejects.toThrow('scoped context')
    const key = { agent: 'unknown-tools' }
    const scope = createScope(ctx, key)
    await scope.ctx.plugin(Policy, { tools: ['missing'] })
    await expect(ctx.systemPrompt.assemble({ scope: { agent: 'unused' } })).resolves.toBeDefined()
    await expect(ctx.systemPrompt.assemble({ scope: key })).rejects.toThrow('unknown tool')
  } finally { await ctx.fiber.dispose() }
})

it.each([false, true])('declares workflow only when delegation=%s and keeps benchmark opt-in', async (delegation) => {
  const ctx = new Context()
  try {
    await ctx.plugin(Loader)
    await ctx.plugin(Projections)
    await ctx.plugin(Presets, { default: 'data-agent' })
    const register = vi.spyOn(ctx.agentPresets, 'register').mockResolvedValue(async () => {})
    const config: Preset.Config = Preset.Config()
    expect(config.tools).toEqual([
      'read', 'grep', 'find', 'ls', 'sql', 'report',
    ])
    config.delegation = delegation
    config.benchmark = delegation
    await ctx.plugin(Preset, config)
    const declaration = register.mock.calls[0]![0]
    expect(declaration.plugins?.some(entry => entry.id === 'delegation')).toBe(delegation)
    expect(declaration.plugins?.some(entry => entry.id === 'present')).toBe(false)
    expect(declaration.plugins?.find(entry => entry.id === 'analysis-policy')?.config).toEqual({
      tools: [...Preset.Config().tools, 'ask', ...(delegation ? ['benchmark', 'subagent', 'workflow'] : [])],
    })
  } finally { await ctx.fiber.dispose() }
})
