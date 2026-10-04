/** Real Loader, AgentLoop, database worker, and request snapshots; only inference is scripted. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import LlmRuntime, { LlmAdapter, createUserMessage, ToolCallId } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import Sessions, { SessionId } from '@deepseek-ai/dsh-session'
import Projections from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import Tools from '@deepseek-ai/dsh-tools'
import Agents, { assembleContextFor } from '@deepseek-ai/dsh-agent'
import Loop from '@deepseek-ai/dsh-agent-loop'
import Commands from '@deepseek-ai/dsh-commands'
import Query from '@deepseek-ai/dsh-session-query-sqlite'
import UserQuestions from '@deepseek-ai/dsh-user-questions'
import FsLocal from '@deepseek-ai/dsh-fs-local'
import SubprocessLocal from '@deepseek-ai/dsh-subprocess-local'
import SpillLocal from '@deepseek-ai/dsh-spill-local'
import * as Primitives from '../src/primitives.ts'
import * as Analysis from '../src/analysis.ts'
import * as DataPlugin from '../src/index.ts'
import * as Policy from '../src/policy.ts'
import * as Preset from '../src/preset.ts'
import { readRequest } from '../src/trace.ts'
import { installQuestionsApi } from '../src/questions-api.ts'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection/src/rpc-host.ts'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { foldDataScope } from '../src/data-scope.ts'
import { installDataApi } from '../src/web-api.ts'

let context: Context | undefined
let root: string | undefined
afterEach(async () => {
  await context?.fiber.dispose()
  if (root) await rm(root, { recursive: true, force: true })
  context = undefined
  root = undefined
})

class AnalysisModel extends LlmAdapter {
  requests: GenerateOptions[] = []
  fail = false
  knowledgeOnly = false
  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({
      provider,
      id: model,
      name: model,
      inputModalities: ['text'],
    })
  }
  async *stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (this.fail) throw new Error('Fixture inference unavailable')
    const count = this.requests.length
    const observation = options.messages.findLast(message => message.role === 'tool')
    const text = observation?.content.find(block => block.type === 'text')
    const value: unknown = text?.type === 'text' && count === 3 ? JSON.parse(text.text) : undefined
    let name: string
    let args: object
    switch (count) {
      case 1: {
        const system = options.messages.filter(message => message.role === 'system')
          .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
        const directory = /资料目录：([^\n]+)/.exec(system)![1]!.trim()
        const filename = this.knowledgeOnly ? 'business.md' : 'schema.md'
        const path = system.split('\n').find(line => line.startsWith(`- ${filename}：`))!.split('：')[1]!
        name = 'read'
        args = { file_path: `${directory}/${path}` }
        break
      }
      case 2:
        if (this.knowledgeOnly) {
          yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Revenue is a fixture metric in cents.' } }
          yield { type: 'finish', reason: { kind: 'stop' } }
          return
        }
        name = 'sql'
        args = { database: 'shop.db', sql: 'SELECT SUM(amount) AS total FROM orders' }
        break
      case 3: {
        const result = z.object({ resultId: z.string(), rows: z.array(z.object({ total: z.number() })) }).parse(value)
        name = 'report'
        args = { markdown: `Total: ${result.rows[0]!.total}`, title: 'Sales', formats: ['md', 'html'] }
        break
      }
      case 4:
        name = 'report'
        args = { markdown: 'Total: 60 units', title: 'Sales', formats: ['md', 'html'] }
        break
      case 5: {
        name = 'benchmark'
        args = { answer: 'Total is 60.', sql: 'SELECT SUM(amount) AS total FROM orders' }
        break
      }
      default:
        yield { type: 'block-end', index: 0, block: { type: 'text', text: 'Report generated from verified total 60.' } }
        yield { type: 'finish', reason: { kind: 'stop' } }
        return
    }
    yield {
      type: 'block-end',
      index: 0,
      block: {
        type: 'tool-call',
        id: ToolCallId(`call-${count}`),
        name,
        arguments: JSON.stringify(args),
      },
    }
    yield { type: 'finish', reason: { kind: 'tool-calls' } }
  }
}

async function setup(mountAnalysis = true) {
  root = await mkdtemp(join(tmpdir(), 'dsh-data-loader-'))
  await mkdir(join(root, 'databases'))
  await mkdir(join(root, 'docs'))
  await writeFile(join(root, 'docs', 'schema.md'), '# Manual schema\norders(id INTEGER, amount REAL)')
  await writeFile(join(root, 'docs', 'sources.json'), JSON.stringify({ version: 2,
    sources: [{ database: 'shop.db', documents: [{ filename: 'schema.md', category: 'schema' }] }] }))
  const database = new DatabaseSync(join(root, 'databases', 'shop.db'))
  database.exec('CREATE TABLE orders(id INTEGER,amount REAL); INSERT INTO orders VALUES(1,10),(2,20),(3,30)')
  database.close()
  const ctx = (context = new Context())
  ctx.baseUrl = pathToFileURL(root).href + '/'
  await ctx.plugin(Loader)
  Object.assign(ctx.loader.builtins, {
    include: Include,
    llm: LlmRuntime,
    sessions: Sessions,
    projections: Projections,
    prompt: SystemPrompt,
    tools: Tools,
    agents: Agents,
    loop: Loop,
    commands: Commands,
    query: Query,
    data: DataPlugin,
    fs: FsLocal,
    subprocess: SubprocessLocal,
    questions: UserQuestions,
    spill: SpillLocal,
  })
  const file = join(root, 'cordis.yml')
  await writeFile(
    file,
    ['llm', 'sessions', 'projections', 'prompt', 'tools', 'agents', 'loop', 'commands', 'query', 'data', 'fs', 'subprocess', 'questions', 'spill']
      .map(
        name =>
          `- name: cordis:${name}\n${name === 'query' ? '  config: {path: ":memory:", openAt: never}\n' : name === 'data' ? `  config: ${JSON.stringify({ directory: join(root!, 'databases'), artifactsDirectory: join(root!, 'evidence'), documentsDirectory: join(root!, 'docs'), uiDist: '' })}\n` : name === 'spill' ? `  config: ${JSON.stringify({ root: join(root!, 'spills'), cleanupPeriodDays: 0 })}\n` : ''}`,
      )
      .join(''),
  )
  await ctx.loader.create({
    name: 'cordis:include',
    config: { path: pathToFileURL(file).href },
  })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  const model = new AnalysisModel()
  ctx.llm.registerAdapter(['fixture'], model)
  const agent = await ctx.agentLoop.create(SessionId('data-loader'), {
    provider: 'fixture',
    model: 'scripted',
  })
  await agent.ctx.plugin(Primitives)
  if (mountAnalysis) await agent.ctx.plugin(Analysis, { benchmark: true })
  await ctx.dataAgent.analysisContext(agent.session.id)
  return {
    ctx,
    model,
    agent,
    data: new DataPlugin.DataCore(
      new DataPlugin.Config(Object.assign(DataPlugin.Config(), {
        directory: join(root, 'databases'),
        artifactsDirectory: join(root, 'evidence'),
        documentsDirectory: join(root, 'docs'),
        uiDist: '',
        mysqlDatabases: [],
        mysqlUrlEnv: 'MYSQL_URL',
        maxRows: 50,
        maxResultRows: 100000,
        maxResultBytes: 50000000,
        queryTimeoutMs: 30000,
        cancellationGraceMs: 5000,
        documentPageChars: 12000,
        maxChartPoints: 100,
        browserExecutablePath: '',
      })),
    ),
  }
}

it('keeps analysis tools and source prompts in their owning scope and removes them on disposal', async () => {
  const { ctx, agent } = await setup(false)
  const other = await ctx.agentLoop.create(SessionId('unrelated-coding-agent'), { provider: 'fixture', model: 'scripted' })
  const analysis = await agent.ctx.plugin(Analysis, { benchmark: false })
  const describe = async (scope?: typeof agent) => {
    const assembly = await ctx.systemPrompt.assemble(scope ? assembleContextFor(scope) : {})
    return {
      tools: assembly.tools.map(tool => tool.name),
      sections: assembly.sections.filter(section => section.name.startsWith('data-agent:')).map(section => ({ name: section.name, text: section.text })),
    }
  }
  for (const value of [await describe(), await describe(other)]) {
    expect(value.tools).not.toContain('sql')
    expect(value.tools).not.toContain('report')
    expect(value.tools).not.toContain('benchmark')
    expect(value.sections).toEqual([])
  }
  expect((await describe(agent)).tools.sort()).toEqual(['ask', 'find', 'grep', 'ls', 'read', 'report', 'sql'])
  expect((await describe(agent)).tools).not.toContain('benchmark')
  expect((await describe(agent)).sections.map(section => section.text).join('\n')).toContain('schema.md')
  expect(await ctx.tools.execute({
    agent: other, name: 'sql', arguments: { sql: 'SELECT 1' }, callId: ToolCallId('wrong-preset-sql'), signal: new AbortController().signal,
  })).toMatchObject({ isError: true })
  await analysis.dispose()
  expect((await describe(agent)).sections).toEqual([])
  expect((await describe(agent)).tools).not.toContain('sql')
  await agent.ctx.plugin(Analysis, { benchmark: true })
  expect((await describe(agent)).tools).toContain('benchmark')
}, 20000)

it('saves complete over-cap grep and find lists readable in the analysis scope', async () => {
  const { ctx, agent } = await setup()
  const directory = join(root!, 'search')
  await mkdir(directory)
  const filenames = Array.from({ length: 120 }, (_, index) => `document-${index}.md`)
  await Promise.all(filenames.map(filename => writeFile(join(directory, filename), '# Fixture')))
  await writeFile(join(directory, 'metrics.txt'), Array.from({ length: 300 }, (_, index) => `metric-${index}`).join('\n'))
  for (const [name, args, count] of [
    ['grep', { pattern: 'metric-', path: directory, include: '*.txt' }, 300],
    ['find', { pattern: '*.md', path: directory }, 120],
  ] as const) {
    const result = await ctx.tools.execute({
      agent, name, arguments: args, callId: ToolCallId(`search-${name}`), signal: new AbortController().signal,
    })
    expect(result.isError).toBe(false)
    const text = result.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    expect(text).toContain(name === 'grep' ? `Found 250 of ${count} matches` : `Showing 100 of ${count} paths`)
    const path = /stored at: (.+?\.txt)\./.exec(text)?.[1]
    expect(path).toBeDefined()
    const complete = await readFile(path!, 'utf8')
    if (name === 'grep') {
      expect(complete).toContain('Found 300 matches')
      expect(complete).toContain('Line 300: metric-299')
    } else {
      expect(complete.trim().split('\n')).toHaveLength(120)
      for (const filename of filenames) expect(complete).toContain(filename)
    }
    const read = await ctx.tools.execute({
      agent, name: 'read', arguments: { file_path: path! }, callId: ToolCallId(`read-${name}`), signal: new AbortController().signal,
    })
    expect(read.isError).toBe(false)
    expect(read.content.some(block => block.type === 'text' && block.text.includes(name === 'grep' ? 'metric-299' : 'document-119.md'))).toBe(true)
  }
}, 20000)

it('loads the domain independently of Web, reads schema MD, queries, reports and commits the final submission', async () => {
  const { ctx, model, agent, data } = await setup()
  const historyReads = vi.spyOn(ctx.sessionQuery, 'readSession')
  agent.followup(
    createUserMessage({
      content: [{ type: 'text', text: 'Compute total amount and make a report.' }],
      source: { kind: 'user' },
    }),
  )
  await agent.whenIdle()
  expect(historyReads).not.toHaveBeenCalled()
  const events = (await ctx.sessionQuery.readSession(agent.session.id)).events
  expect(events.filter(event => event.type === 'tool/result' && event.data.message.isError)).toEqual([])
  expect(model.requests).toHaveLength(6)
  const prompt = JSON.stringify(model.requests[0]?.messages.filter(message => message.role === 'system').map(message => message.content))
    .replaceAll(root!.replaceAll('\\', '/'), '<fixture-root>')
  expect(prompt).toMatchSnapshot()
  expect(events.filter(event => event.type === 'tool/result').map(event => event.type === 'tool/result' ? event.data.meta : undefined))
    .toContainEqual(expect.objectContaining({ answer: 'Total is 60.' }))
  const locators = events.filter(event => event.type === 'data-agent/request')
  expect(locators).toHaveLength(6)
  for (const [index, event] of locators.entries()) {
    if (event.type !== 'data-agent/request') throw new Error('Missing locator')
    const { signal: _signal, ...actual } = model.requests[index]!
    const saved = await readRequest(data, agent.session.id, event.data.requestId)
    expect(saved.snapshot.request).toEqual(JSON.parse(JSON.stringify(actual)))
    expect(saved.sha256).toBe(event.data.sha256)
    expect(event.ignorable).toBe(true)
    expect(event.data.inputThroughSeq).toBeLessThan(event.seq)
  }
  expect(JSON.stringify(model.requests[2])).toContain('orders')
  expect(JSON.stringify(model.requests[2])).toContain('Inspect the rows before concluding')
  const reportFiles = events.filter(event => event.type === 'tool/result' && event.data.meta !== null && typeof event.data.meta === 'object' && 'reportId' in event.data.meta)
    .map(event => z.object({ document: z.object({ path: z.string() }) }).parse(event.type === 'tool/result' ? event.data.meta : undefined))
  expect(reportFiles).toHaveLength(2)
  const endings = events.filter(event => event.type === 'data-agent/request-end')
  expect(endings).toHaveLength(6)
  expect(JSON.stringify(endings)).not.toContain('inputTokens')
  expect(await readFile(reportFiles[0]!.document.path, 'utf8')).toContain('60')
}, 20000)

it('records the general tools, rejects removed calls and completes SQL analysis with a report', async () => {
  const { ctx, model, agent, data } = await setup()
  await agent.ctx.plugin(Policy, { tools: [...Preset.Config().tools, 'ask', 'benchmark'] })
  for (const name of ['write', 'edit', 'bash', 'finish', 'analyze_data', 'import_dataset', 'render_chart']) {
    expect(await ctx.tools.execute({
      agent, name, callId: ToolCallId(`removed-${name}`), arguments: {}, signal: new AbortController().signal,
    })).toMatchObject({
      isError: true, content: [{ type: 'text', text: 'Error: This tool is disabled by the analysis preset.' }],
    })
  }
  agent.followup(createUserMessage({
    content: [{ type: 'text', text: 'Compute total amount in SQL and make a report.' }], source: { kind: 'user' },
  }))
  await agent.whenIdle()
  const tools = model.requests[0]?.tools
  expect(tools?.map(tool => tool.name)).toEqual([
    'ask', 'benchmark', 'find', 'grep', 'ls', 'read', 'report', 'sql',
  ])
  expect(tools).toMatchSnapshot()
  const events = (await ctx.sessionQuery.readSession(agent.session.id)).events
  expect(events.filter(event => event.type === 'tool/result' && event.data.message.isError)).toEqual([])
  expect(events.filter(event => event.type === 'tool/result' && event.data.meta !== null
    && typeof event.data.meta === 'object' && 'sql' in event.data.meta).map(event => event.type === 'tool/result' ? event.data.meta : undefined))
    .toContainEqual(expect.objectContaining({ answer: 'Total is 60.', sql: 'SELECT SUM(amount) AS total FROM orders' }))
  const first = events.find(event => event.type === 'data-agent/request')
  if (first?.type !== 'data-agent/request') throw new Error('Missing request locator')
  expect((await readRequest(data, agent.id, first.data.requestId)).snapshot.request.tools).toEqual(tools)
  expect(JSON.stringify(model.requests[0]?.messages)).toContain('用 sql 只读查询')
}, 20000)

it('reads independent business knowledge through logged model tools in the real Loader composition', async () => {
  const { ctx, model, agent, data } = await setup()
  model.knowledgeOnly = true
  await data.businesses.uploadKnowledge('shop.db', 'shop.db', 'business.md', 'Revenue is a fixture metric in cents.')
  await data.businesses.uploadKnowledge('shop.db', 'shop.db', 'refunds.md', 'Refund definitions require confirmation.')
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Read the business knowledge and explain the revenue unit.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const events = (await ctx.sessionQuery.readSession(agent.session.id)).events
  expect(events.filter(event => event.type === 'tool/call').map(event => event.type === 'tool/call' ? event.data.name : '')).toEqual(['read'])
  expect(events.filter(event => event.type === 'tool/result' && event.data.message.isError)).toEqual([])
  expect(model.requests).toHaveLength(2)
  expect(JSON.stringify(model.requests[1]?.messages)).toContain('Revenue is a fixture metric in cents.')
  expect(JSON.stringify(model.requests[0]?.messages)).toContain('refunds.md')
  expect(JSON.stringify(model.requests[1]?.messages)).not.toContain('Refund definitions require confirmation.')
}, 20000)

it('records a concise source-owned reading list without unrelated directory or path guidance', async () => {
  const { ctx, model, agent } = await setup()
  const directory = join(root!, 'docs')
  for (const [filename, markdown] of [
    ['source-business.md', 'Source meanings.'], ['analysis-business.md', 'Analysis meanings.'],
    ['analysis-skill.md', 'Optional skill.'], ['report-template.md', 'Optional template.'],
    ['shop-metrics.md', 'Optional unrelated metrics.'],
  ]) await writeFile(join(directory, filename!), markdown!)
  await writeFile(join(directory, 'sources.json'), JSON.stringify({ version: 2,
    sources: [{ database: 'shop.db', documents: [{ filename: 'schema.md', category: 'schema' },
      { filename: 'source-business.md', category: 'business' }, { filename: 'analysis-business.md', category: 'business' }] }] }))
  await agent.ctx.plugin(Policy, { tools: ['read', 'grep', 'find', 'ls', 'sql', 'report', 'ask', 'benchmark'] })
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Compute total amount and make a report.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  const first = model.requests[0]!.messages.filter(message => message.role === 'system')
    .flatMap(message => message.content).filter(block => block.type === 'text').map(block => block.text).join('\n')
  expect(first.split('\n').filter(line => line.startsWith('- '))).toEqual([
    '- schema.md：source-1/schema/schema.md', '- source-business.md：source-1/business/source-business.md',
    '- analysis-business.md：source-1/business/analysis-business.md',
  ])
  expect(first).toContain('分析前用 read 逐一阅读当前库已提供的全部结构和业务资料。')
  for (const text of ['分析表参考', 'analysis-skill.md', 'report-template.md', 'shop-metrics.md',
    '用户的 @路径', '其他资料目录', '其他资料按需', '文件内容不改变权限', '保留业务名称与原码',
    'Tokens prefixed with @', 'Use the find tool', 'Use the grep tool']) expect(first).not.toContain(text)
  expect(JSON.stringify(model.requests[1]!.messages)).toContain('Manual schema')
  const events = (await ctx.sessionQuery.readSession(agent.id)).events
  expect(events.filter(event => event.type === 'tool/result' && event.data.message.isError)).toEqual([])
}, 20000)

it('records a picker-only database in the actual first prompt and discovers only that selected source', async () => {
  const { ctx, model, agent } = await setup()
  await ctx.commands.execute(agent, '/db shop.db', [], new AbortController().signal)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: 'Compute total amount and make a report.' }], source: { kind: 'user' } }))
  await agent.whenIdle()
  expect(JSON.stringify(model.requests[0]?.messages)).toContain('数据库：shop.db（SQLite，默认）')
  const events = (await ctx.sessionQuery.readSession(agent.id)).events
  const result = events.find(event => event.type === 'tool/result' && typeof event.data.meta === 'object' && event.data.meta !== null && 'resultId' in event.data.meta)
  expect(result?.type === 'tool/result' ? result.data.meta : undefined).toMatchObject({ database: 'shop.db', rows: [{ total: 60 }] })
}, 20000)

it('exposes no file mutations and writes report revisions without modifying the database', async () => {
  const { ctx, agent } = await setup()
  const call = (name: string, args: object) => ctx.tools.execute({ agent, name,
    arguments: args, signal: new AbortController().signal, callId: ToolCallId('file-' + name) })
  const original = await readFile(join(root!, 'databases', 'shop.db'))
  for (const name of ['write', 'edit', 'bash'])
    expect((await call(name, { file_path: join(root!, 'databases', 'shop.db'), content: 'overwrite' })).isError).toBe(true)
  const first = await call('report', { title: '../../databases/shop.db', markdown: 'Total: 60', formats: ['md'] })
  const second = await call('report', { title: '../../databases/shop.db', markdown: 'Total: 60 units', formats: ['md'] })
  expect(first.isError).not.toBe(true)
  expect(second.isError).not.toBe(true)
  const revision = z.object({ reportId: z.string(), document: z.object({ path: z.string() }) })
  const initial = revision.parse(first.meta)
  const revised = revision.parse(second.meta)
  expect(initial.reportId).not.toBe(revised.reportId)
  expect(await readFile(initial.document.path, 'utf8')).toContain('Total: 60')
  expect(await readFile(revised.document.path, 'utf8')).toContain('Total: 60 units')
  expect(await readFile(join(root!, 'databases', 'shop.db'))).toEqual(original)
}, 20000)

it('hides benchmark submissions from ordinary analysis', async () => {
  const { ctx, agent } = await setup()
  await agent.ctx.plugin(Policy, { tools: [...Preset.Config().tools, 'ask'] })
  const assembly = await ctx.systemPrompt.assemble({ scope: agent })
  expect(assembly.tools.map(tool => tool.name)).toEqual(['ask', 'find', 'grep', 'ls', 'read', 'report', 'sql'])
  expect((await ctx.tools.execute({ agent, name: 'benchmark', callId: ToolCallId('disabled-benchmark'),
    arguments: { sql: 'SELECT 1' }, signal: new AbortController().signal })).isError).toBe(true)
}, 20000)

it('keeps failed model attempts inspectable with unavailable usage', async () => {
  const { ctx, model, agent } = await setup()
  model.fail = true
  agent.followup(
    createUserMessage({
      content: [{ type: 'text', text: 'Analyze.' }],
      source: { kind: 'user' },
    }),
  )
  await agent.whenIdle()
  const events = (await ctx.sessionQuery.readSession(agent.session.id)).events
  expect(events.find(event => event.type === 'data-agent/request-end')?.data).toMatchObject({
    status: 'failed',
    error: 'Fixture inference unavailable',
  })
}, 20000)

it('logs database selection after catalog validation and restores default database commands', async () => {
  const { ctx, agent, data } = await setup()
  const scope = {
    version: 2,
    sources: [{ database: 'shop.db' }],
    defaultDatabase: 'shop.db',
  }
  const signal = new AbortController().signal
  expect(
    (await ctx.commands.execute(agent, `/data_scope ${JSON.stringify(scope)}`, [], signal))?.result.kind,
  ).toBe('success')
  const invalid = { ...scope, sources: [{ database: 'missing.db' }], defaultDatabase: 'missing.db' }
  await expect(
    ctx.commands.execute(agent, `/data_scope ${JSON.stringify(invalid)}`, [], signal),
  ).rejects.toThrow('unknown')
  expect(foldDataScope((await ctx.sessionQuery.readSession(agent.id)).events)).toEqual(scope)
  const legacy = { version: 1, sources: [{ database: 'shop.db', tables: [] }], defaultDatabase: 'shop.db' }
  const previous = (await ctx.sessionQuery.readSession(agent.id)).events.map(event =>
    event.type === 'command/done' && event.data.text?.startsWith('data-agent-scope:')
      ? { ...event, data: { ...event.data, text: `data-agent-scope:${JSON.stringify(legacy)}` } } : event)
  expect(foldDataScope(previous)).toEqual(scope)
  const restored = new DataPlugin.DataCore(data.config, undefined, async () => foldDataScope(previous))
  expect((await restored.metadata(agent.id, 'shop.db', signal)).tables.map(table => table.name)).toEqual(['orders'])
  await ctx.commands.execute(agent, '/db clear', [], signal)
  expect(foldDataScope((await ctx.sessionQuery.readSession(agent.id)).events)).toEqual({
    ...scope,
    defaultDatabase: null,
  })
  await ctx.commands.execute(agent, '/db missing.db', [], signal)
  expect(foldDataScope((await ctx.sessionQuery.readSession(agent.id)).events)?.defaultDatabase).toBeNull()
  agent.ctx.effect(
    () => agent.ctx.systemPrompt.suppressRuntimeContext(),
    'scope fixture: suppressed generic context',
  )
  agent.followup(
    createUserMessage({
      content: [{ type: 'text', text: 'Compute total amount and make a report.' }],
      source: { kind: 'user' },
    }),
  )
  await agent.whenIdle()
  const actual = (await ctx.sessionQuery.readSession(agent.id)).events.filter(
    event => event.type === 'data-agent/request',
  )
  expect(actual.length).toBeGreaterThan(0)
  const request = actual[0]!
  if (request.type !== 'data-agent/request') throw new Error('Missing request locator')
  const recorded = await readRequest(
    new DataPlugin.DataCore(new DataPlugin.Config(Object.assign(DataPlugin.Config(), { artifactsDirectory: join(root!, 'evidence') }))),
    agent.id,
    request.data.requestId,
  )
  expect(JSON.stringify(recorded.snapshot.request)).toContain('数据库：shop.db（SQLite）')
}, 20000)

it('serves schema Markdown and validates human uploads through the authenticated route registry', async () => {
  const { ctx, agent, data } = await setup()
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  installDataApi(ctx, data)
  const handler = connection.createSharedFetchHandler('/api')
  const query = `sessionId=${agent.id}&database=shop.db&full=1`
  const initial = await handler.fetch(new Request(`http://host/api/data-agent/schema?${query}`))
  expect(initial.status).toBe(200)
  expect(JSON.stringify(await initial.json())).toContain('Manual schema')
  const post = (raw: object) =>
    handler.fetch(
      new Request('http://host/api/data-agent/schema/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(raw),
      }),
    )
  expect(
    (await post({ database: 'missing.db', filename: 'schema.md', markdown: 'Business meaning' })).status,
  ).toBe(400)
  expect((await post({ database: 'shop.db', filename: 'schema.html', markdown: '<script />' })).status).toBe(
    400,
  )
  expect(
    (await post({ database: 'shop.db', filename: 'schema-notes.md', markdown: 'Amount means simulated sales.' }))
      .status,
  ).toBe(200)
  const downloaded = await handler.fetch(new Request(`http://host/api/data-agent/schema?${query}&download=1`))
  expect(downloaded.headers.get('content-disposition')).toContain('schema.md')
  expect(await downloaded.text()).toContain('Amount means simulated sales.')
  const knowledgePost = (raw: object) =>
    handler.fetch(
      new Request('http://host/api/data-agent/business/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(raw),
      }),
    )
  expect(
    (await knowledgePost({ database: 'missing.db', filename: 'business.md', markdown: 'Unknown source' }))
      .status,
  ).toBe(400)
  expect(
    (await knowledgePost({ database: 'shop.db', filename: 'business.html', markdown: 'Not Markdown' }))
      .status,
  ).toBe(400)
  expect(
    (
      await knowledgePost({
        database: 'shop.db',
        filename: 'business.md',
        markdown: 'Paid orders exclude refunds.',
      })
    ).status,
  ).toBe(200)
  const business = await handler.fetch(new Request(`http://host/api/data-agent/business?${query}&download=1`))
  expect(business.headers.get('content-disposition')).toContain('business.md')
  expect(await business.text()).toContain('Paid orders exclude refunds')
  expect((await data.schema(agent.id, 'shop.db', new AbortController().signal)).markdown).not.toContain(
    'Paid orders exclude refunds',
  )
}, 20000)

it.each(['schema', 'business'] as const)('manages %s documents with source and version checks through authenticated routes', async (category) => {
  const { ctx, agent, data } = await setup()
  await writeFile(join(root!, 'docs', 'sources.json'), JSON.stringify({ version: 2, sources: [] }))
  const otherCategory = category === 'schema' ? 'business' : 'schema'
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  installDataApi(ctx, data)
  const handler = connection.createSharedFetchHandler('/api')
  const post = (path: string, body: object) => handler.fetch(new Request(`http://host/api/data-agent/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  }))
  const list = async (kind = category, database = 'shop.db') => {
    const response = await handler.fetch(new Request(`http://host/api/data-agent/knowledge?sessionId=${agent.id}&database=${database}&category=${kind}`))
    expect(response.status).toBe(200)
    const document = z.object({ id: z.string(), version: z.string(), filename: z.string(), enabled: z.boolean() })
    return z.object({ documents: z.array(document) }).parse(await response.json()).documents
  }
  for (const filename of ['metrics.md', 'refunds.md']) expect((await post(`${category}/upload`, { database: 'shop.db', filename, markdown: `# ${filename}` })).status).toBe(200)
  const documents = await list()
  expect(documents.map(item => item.filename)).toEqual(['metrics.md', 'refunds.md'])
  const first = documents[0]!
  const selection = { sessionId: agent.id, database: 'shop.db', category, id: first.id, version: first.version }
  const downloadUrl = `http://host/api/data-agent/knowledge/download?${new URLSearchParams(selection)}`
  const downloaded = await handler.fetch(new Request(downloadUrl))
  expect(await downloaded.text()).toBe('# metrics.md')
  expect(downloaded.headers.get('content-disposition')).toContain('metrics.md')
  expect((await post('knowledge/change', { ...selection, category: otherCategory, action: { remove: true } })).status).toBe(400)
  expect((await post('knowledge/change', { ...selection, database: 'missing.db', action: { remove: true } })).status).toBe(400)
  expect((await post('knowledge/change', { ...selection, action: { enabled: false } })).status).toBe(200)
  expect((await list())[0]?.enabled).toBe(false)
  expect((await post(`${category}/upload`, { database: 'shop.db', filename: 'metrics.md', markdown: '# Revised', replace: first })).status).toBe(200)
  expect((await handler.fetch(new Request(downloadUrl))).status).toBe(400)
  expect((await post('knowledge/change', { ...selection, action: { remove: true } })).status).toBe(400)
  const revised = (await list())[0]!
  expect((await post('knowledge/change', { ...selection, version: revised.version, action: { remove: true } })).status).toBe(200)
  expect((await list()).map(item => item.filename)).toEqual(['refunds.md'])
  expect((await handler.fetch(new Request(`http://host/api/data-agent/knowledge?sessionId=${agent.id}&database=shop.db&category=invalid`))).status).toBe(400)
  const store = category === 'schema' ? data.schemas : data.businesses
  expect((await store.collection('shop.db')).documents.map(document => document.filename)).toEqual(['refunds.md'])
}, 20000)

it.each([0, 1])('exports request traces with byte limit %s, treating zero as unlimited', async (maxResultBytes) => {
  const { ctx, agent, data } = await setup()
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  data.config.maxResultBytes = maxResultBytes
  installDataApi(ctx, data)
  const handler = connection.createSharedFetchHandler('/api')
  const response = await handler.fetch(new Request(`http://host/api/trace/export?sessionId=${agent.id}`))
  expect(response.status).toBe(maxResultBytes === 0 ? 200 : 400)
  const value: unknown = await response.json()
  if (maxResultBytes === 0) expect(value).toMatchObject({ sessions: [{ sessionId: agent.id }] })
  else expect(value).toMatchObject({ error: 'Trace export exceeds the configured byte limit; inspect individual requests instead.' })
}, 20000)

it('answers a session-owned clarification and rejects mismatched or invalid submissions', async () => {
  const { ctx, agent } = await setup()
  // The exact Fetch registry is exercised here; HTTP authentication is owned by Connection.
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  installQuestionsApi(ctx)
  const questions = [
    {
      id: 'metric',
      question: 'Which metric?',
      options: [{ label: 'Orders' }, { label: 'Revenue' }],
    },
  ]
  const answer = ctx.waterfall('user-questions/request', { agent, questions }, async () => ({ answers: [] }))
  const handler = connection.createSharedFetchHandler('/api')
  const pending = z
    .object({ requests: z.array(z.object({ requestId: z.string() })) })
    .parse(
      await (
        await handler.fetch(new Request(`http://host/api/data-agent/questions?sessionId=${agent.id}`))
      ).json(),
    )
  const requestId = pending.requests[0]!.requestId
  const post = (sessionId: string, selected: string[]) =>
    handler.fetch(
      new Request('http://host/api/data-agent/answer', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          requestId,
          answers: [{ id: 'metric', selected }],
        }),
      }),
    )
  expect((await post('wrong-session', ['Orders'])).status).toBe(400)
  expect((await post(agent.id, ['Unknown'])).status).toBe(400)
  expect((await post(agent.id, ['Orders', 'Revenue'])).status).toBe(400)
  expect((await post(agent.id, ['Orders'])).status).toBe(200)
  expect(await answer).toEqual({
    answers: [{ id: 'metric', selected: ['Orders'] }],
  })
  expect((await post(agent.id, ['Orders'])).status).toBe(400)
}, 20000)

it('cancels pending clarification and disposes its routes on unload', async () => {
  const { ctx, agent } = await setup()
  const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
  const fiber = ctx.plugin(installQuestionsApi)
  await fiber.await()
  const controller = new AbortController()
  const questions = [{ id: 'metric', question: 'Which metric?' }]
  const pending = ctx.waterfall(
    'user-questions/request',
    { agent, questions, signal: controller.signal },
    async () => ({ answers: [] }),
  )
  const rejected = expect(pending).rejects.toThrow('cancelled')
  controller.abort()
  await rejected
  const handler = connection.createSharedFetchHandler('/api')
  expect(
    await (
      await handler.fetch(new Request(`http://host/api/data-agent/questions?sessionId=${agent.id}`))
    ).json(),
  ).toEqual({ requests: [] })
  const unloading = ctx.waterfall('user-questions/request', { agent, questions }, async () => ({
    answers: [],
  }))
  const disposed = expect(unloading).rejects.toThrow('unloaded')
  await fiber.dispose()
  await disposed
  expect((await handler.fetch(new Request('http://host/api/data-agent/questions'))).status).toBe(404)
}, 20000)
