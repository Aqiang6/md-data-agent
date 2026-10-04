/** Authenticated desktop model-API smoke through a real dsh Web profile and loopback provider. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { appendFile, mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve('.')
const run = await mkdtemp(join(repo, '.playwright-mcp', 'data-models-'))
const workspace = await mkdtemp(join(tmpdir(), 'data-agent-models-'))
const { chromium } = createRequire(join(repo, 'apps/web/package.json'))('playwright')
const requests = []
let hold
let pendingReply
const provider = createServer(async (request, response) => {
  const chunks = []
  for await (const chunk of request) chunks.push(chunk)
  const raw = Buffer.concat(chunks).toString()
  const body = raw ? JSON.parse(raw) : undefined
  const tools = body?.tools?.map(tool => tool.function.name) ?? []
  const analysis = tools.includes('sql')
  const system = body?.messages?.filter(message => message.role === 'system').map(message => message.content).join('\n') ?? ''
  requests.push({ path: request.url, authorized: request.headers.authorization === 'Bearer synthetic-loopback-key', model: body?.model, analysis,
    tools, analysisGuide: system.includes('分析前用 read 逐一阅读'), sourceContext: system.includes('当前未启用数据库。') })
  if (request.url === '/v1/models') {
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ data: [{ id: 'loopback-analysis', object: 'model' }] }))
    return
  }
  if (request.url !== '/v1/chat/completions') { response.writeHead(404).end(); return }
  provider.emit('fixture-request', requests.at(-1))
  const reply = () => {
    response.writeHead(200, { 'content-type': 'text/event-stream' })
    const chunk = { id: 'loopback-call', object: 'chat.completion.chunk', created: 1, model: 'loopback-analysis' }
    response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: { role: 'assistant', content: 'MODEL_CUSTOM_OK' }, finish_reason: null }] })}\n\n`)
    response.write(`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 4, total_tokens: 14 } })}\n\n`)
    response.end('data: [DONE]\n\n')
  }
  if (hold && analysis) { pendingReply = reply; hold(); hold = undefined }
  else reply()
})
await new Promise((accept, reject) => { provider.once('error', reject); provider.listen(0, '127.0.0.1', accept) })
const providerAddress = provider.address()
assert(providerAddress && typeof providerAddress !== 'string')
const endpoint = `http://127.0.0.1:${providerAddress.port}/v1`
const env = { ...process.env, DSH_HOME: join(run, 'home'), DSH_AGENTS_HOME: join(run, 'agents') }
execFileSync(process.execPath, ['--import', 'tsx/esm', 'scripts/prepare-data-agent-profile.ts'], { cwd: repo, windowsHide: true, env, stdio: 'pipe' })
await appendFile(join(env.DSH_HOME, 'profiles', 'data-agent', 'cordis.patch.yml'),
  `\n- id: data-agent\n  config:\n    directory: ${JSON.stringify(join(workspace, 'databases'))}\n    documentsDirectory: ${JSON.stringify(join(workspace, 'documents'))}\n`)
const server = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'data-agent', '--patch', 'apps/web/tests/pin-browse-picker.overlay.yml', '--port', '0', '--no-open'], {
  cwd: repo, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
})
let log = ''
let browser
let context
const exited = new Promise(accept => server.once('exit', accept))
const ready = new Promise((accept, reject) => {
  const timeout = setTimeout(() => reject(new Error('dsh startup timed out')), 60000)
  const collect = bytes => {
    log += bytes.toString()
    const url = log.match(/dsh web: (http:\/\/[^\s]+)/)?.[1]
    if (url) { clearTimeout(timeout); accept(url) }
  }
  server.stdout.on('data', collect)
  server.stderr.on('data', collect)
  server.once('exit', code => { clearTimeout(timeout); reject(new Error(`dsh exited ${code}`)) })
})

try {
  const url = await ready
  browser = await chromium.launch({ headless: true })
  await mkdir(join(run, 'videos'))
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', recordVideo: { dir: join(run, 'videos'), size: { width: 1440, height: 1000 } } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  const origin = new URL(url).origin
  const rpc = async (method, args) => {
    const response = await page.request.post(`${origin}/api/${method}`, { data: { type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } } })
    const envelope = await response.json()
    assert(envelope.result?.ok, JSON.stringify(envelope))
    return envelope.result.value
  }
  const created = await rpc('session/create', { request: { cwd: workspace } })
  assert.equal(created.agentPreset, 'data-agent')
  const legacy = await rpc('session/create', { request: { agentPreset: 'standard', cwd: workspace } })
  await page.reload()
  await page.locator('.session-item').first().waitFor()
  assert.equal(await page.locator('.session-record').count(), 1)
  assert.equal(await page.locator('.session-record.active').getAttribute('data-session-id'), created.sessionId)
  assert.equal(await page.locator(`.session-record[data-session-id="${legacy.sessionId}"]`).count(), 0)
  const initialCatalog = await rpc('session/modelCatalog', {})
  assert.equal(initialCatalog.default.provider, 'deepseek-official')
  assert.equal(initialCatalog.default.model, 'deepseek-flash')
  assert.deepEqual(initialCatalog.routableProviders, ['deepseek-official'])
  assert.equal(await page.locator('.model-used').textContent(), 'deepseek-official / deepseek-flash')
  await page.locator('.side-foot').getByRole('button', { name: '模型与 API', exact: true }).click()
  await page.getByRole('button', { name: '接入模型 API', exact: true }).click()
  await page.getByLabel('供应商标识', { exact: true }).fill('loopback-gateway')
  await page.getByLabel('显示名称', { exact: true }).fill('Loopback Analysis')
  await page.getByLabel('Base URL', { exact: true }).fill(endpoint)
  await page.getByLabel('API 协议', { exact: true }).selectOption('openai-completions')
  await page.getByLabel('API Key', { exact: true }).fill('synthetic-loopback-key')
  await page.getByRole('button', { name: '发现模型', exact: true }).click()
  await page.locator('.model-candidates').getByRole('checkbox').check()
  await page.getByLabel('上下文上限', { exact: true }).fill('131072')
  await page.getByLabel('输出上限', { exact: true }).fill('8192')
  const layouts = []
  for (const size of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }, { width: 1440, height: 1000 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size)
    const geometry = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, detail: document.querySelector('.manager-detail').getBoundingClientRect().toJSON(), inputs: [...document.querySelectorAll('.model-form input')].map(input => input.getBoundingClientRect().toJSON()) }))
    assert(!geometry.overflow)
    assert(geometry.inputs.every(input => input.right <= size.width + 1 && input.x >= geometry.detail.x))
    layouts.push({ size, geometry })
    await page.screenshot({ path: join(run, `custom-api-${size.width}.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.getByRole('button', { name: '保存配置', exact: true }).click()
  await page.getByText('模型配置已保存', { exact: true }).waitFor()
  const settings = await rpc('settings/describe', {})
  const saved = settings.namespaces.find(view => view.ns === 'llm-pi-ai').value.providers['loopback-gateway']
  assert.equal(saved.apiKeyEnv, 'LOOPBACK_GATEWAY_API_KEY')
  assert(!JSON.stringify(settings).includes('synthetic-loopback-key'))
  assert.equal((await rpc('session/modelCatalog', {})).default.provider, 'deepseek-official')
  await page.getByRole('button', { name: '返回分析', exact: true }).click()
  await rpc('session/selectModel', { request: { sessionId: legacy.sessionId, provider: 'loopback-gateway', model: 'loopback-analysis' } })
  const codingStarted = once(provider, 'fixture-request', { signal: AbortSignal.timeout(45000) })
  await rpc('session/prompt', { request: {
    requestId: crypto.randomUUID(), sessionId: legacy.sessionId, mode: 'queue', content: [{ type: 'text', text: 'Reply MODEL_CUSTOM_OK without tools.' }],
  } })
  const [codingRequest] = await codingStarted
  assert(codingRequest)
  assert(!codingRequest.analysisGuide && !codingRequest.sourceContext)
  assert(!codingRequest.tools.includes('sql') && !codingRequest.tools.includes('report') && !codingRequest.tools.includes('benchmark'))
  await page.getByLabel('下次请求', { exact: true }).selectOption(JSON.stringify(['loopback-gateway', 'loopback-analysis']))
  await page.locator('.composer > textarea').fill('Reply MODEL_CUSTOM_OK without tools.')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await page.locator('.msg-assistant').filter({ hasText: 'MODEL_CUSTOM_OK' }).first().waitFor({ timeout: 45000 })
  await page.getByRole('button', { name: '发送', exact: true }).waitFor()
  const analysisRequest = requests.find(request => request.path === '/v1/chat/completions' && request.analysis)
  assert(analysisRequest?.analysisGuide && analysisRequest.sourceContext)
  assert.deepEqual([...analysisRequest.tools].sort(), ['ask', 'find', 'grep', 'ls', 'read', 'report', 'sql'])
  await page.getByText('loopback-gateway / loopback-analysis', { exact: true }).first().waitFor()

  const requested = new Promise(accept => { hold = accept })
  await page.locator('.composer > textarea').fill('Reply MODEL_CUSTOM_OK again without tools.')
  await page.getByRole('button', { name: '发送', exact: true }).click()
  await requested
  await page.getByText('当前模型', { exact: true }).waitFor()
  await page.getByLabel('下次请求', { exact: true }).selectOption(JSON.stringify(['deepseek-official', 'deepseek-flash']))
  await page.waitForFunction(async sessionId => {
    const response = await fetch('/api/session/projections', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: crypto.randomUUID(), method: 'session/projections', payload: { args: { request: { sessionId } } } }) })
    const result = (await response.json()).result
    return result?.value?.values.modelSelection.next?.provider === 'deepseek-official'
  }, created.sessionId)
  assert.equal(await page.locator('.model-used').textContent(), 'loopback-gateway / loopback-analysis')
  await page.screenshot({ path: join(run, 'running-and-next.png') })
  pendingReply()
  pendingReply = undefined
  await page.getByRole('button', { name: '发送', exact: true }).waitFor()
  await page.reload()
  assert.equal(await page.locator(`.session-record[data-session-id="${legacy.sessionId}"]`).count(), 0)
  await page.locator('.model-used').getByText('loopback-gateway / loopback-analysis', { exact: true }).waitFor()
  assert.equal(await page.getByLabel('下次请求', { exact: true }).inputValue(), JSON.stringify(['deepseek-official', 'deepseek-flash']))

  if (process.argv.includes('--live')) {
    await page.locator('.composer > textarea').fill('Do not use any tools. Reply with only MODEL_DEEPSEEK_OK.')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.locator('.msg-assistant').filter({ hasText: 'MODEL_DEEPSEEK_OK' }).first().waitFor({ timeout: 180000 })
    await page.getByRole('button', { name: '发送', exact: true }).waitFor()
    await page.locator('.model-used').getByText('deepseek-official / deepseek-flash', { exact: true }).waitFor()
  }
  for (const size of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }, { width: 1440, height: 1000 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size)
    const geometry = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, composer: document.querySelector('.composer').getBoundingClientRect().toJSON(), model: document.querySelector('.model-control').getBoundingClientRect().toJSON() }))
    assert(!geometry.overflow)
    assert(geometry.model.right <= geometry.composer.right && geometry.model.bottom <= geometry.composer.bottom)
    await page.screenshot({ path: join(run, `model-picker-${size.width}.png`) })
  }
  const traceResponse = await page.request.get(`${origin}/api/trace/export?sessionId=${created.sessionId}`)
  const trace = await traceResponse.json()
  assert.equal(traceResponse.status(), 200, JSON.stringify(trace))
  assert(!JSON.stringify(trace).includes('synthetic-loopback-key'))
  const customRequests = trace.sessions[0].events.filter(event => event.type === 'request/header' && event.data.header.config.provider === 'loopback-gateway')
  assert(customRequests.length >= 1)
  assert.equal(trace.sessions[0].requests.filter(item => item.snapshot.request.provider === 'loopback-gateway').length, 2)
  assert.equal(requests.filter(request => request.path === '/v1/chat/completions' && request.analysis).length, 2)
  assert(requests.filter(request => request.path === '/v1/chat/completions').every(request => request.authorized && request.model === 'loopback-analysis'))
  await page.locator('.side-foot').getByRole('button', { name: '模型与 API', exact: true }).click()
  await page.locator('.model-provider-row').filter({ hasText: 'loopback-gateway' }).click()
  assert.equal(await page.getByLabel('API Key', { exact: true }).inputValue(), '')
  await page.getByRole('button', { name: '移除接入配置', exact: true }).click()
  await page.getByRole('button', { name: '确认移除配置', exact: true }).click()
  await page.getByText('模型配置已移除，凭据保持不变', { exact: true }).waitFor()
  const key = await rpc('credentials/describe', { refs: ['LOOPBACK_GATEWAY_API_KEY'] })
  assert(key.LOOPBACK_GATEWAY_API_KEY.configured)
  const anonymous = await browser.newContext()
  const unauthorized = await anonymous.request.post(`${origin}/api/settings/describe`, { data: { type: 'client-request', rpcId: crypto.randomUUID(), method: 'settings/describe', payload: { args: {} } } })
  assert.equal(unauthorized.status(), 401)
  await anonymous.close()
  assert.deepEqual(errors, [])
  await writeFile(join(run, 'summary.json'), JSON.stringify({ requests, layouts, errors, live: process.argv.includes('--live'), auth: unauthorized.status() }, null, 2))
  await writeFile(join(run, 'trajectory.json'), JSON.stringify(trace, null, 2))
  console.log(JSON.stringify({ run, requests: requests.length, customRequests: customRequests.length, live: process.argv.includes('--live'), desktopWidths: layouts.map(item => item.size.width), errors }))
} catch (error) {
  const page = context?.pages()[0]
  if (page) {
    await page.screenshot({ path: join(run, 'failure.png') })
    console.error((await page.locator('body').innerText()).slice(-5000))
  }
  console.error(log.replace(/token=[^\s]+/gu, 'token=[redacted]').slice(-2200))
  throw error
} finally {
  pendingReply?.()
  await context?.close()
  await browser?.close()
  if (server.exitCode === null) server.kill('SIGINT')
  const timeout = setTimeout(() => { if (server.exitCode === null) server.kill('SIGTERM') }, 10000)
  await exited
  clearTimeout(timeout)
  await new Promise(accept => provider.close(accept))
}
