/** Inspect a running profile without starting another server; archive only this smoke's own analysis. */
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const argument = flag => process.argv[process.argv.indexOf(flag) + 1]
assert(process.argv.includes('--log') && process.argv.includes('--history'), 'Supply --log <server stdout> --history <JSON with sessionId/requestId>.')
const repo = resolve('.')
const run = await mkdtemp(join(repo, '.playwright-mcp', 'request-inspector-'))
const log = await readFile(argument('--log'), 'utf8')
const url = log.match(/dsh web: (http:\/\/[^\s]+)/)?.[1]
assert(url, 'The existing profile must report its URL.')
let historical = JSON.parse(await readFile(argument('--history'), 'utf8'))
const { chromium } = createRequire(join(repo, 'apps/web/package.json'))('playwright')
const browser = await chromium.launch({ headless: true })
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' })
const page = await context.newPage()
const origin = new URL(url).origin
const rpc = async (method, args) => {
  const response = await page.request.post(`${origin}/api/${method}`, { data: {
    type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args },
  } })
  const result = (await response.json()).result
  assert(result?.ok, JSON.stringify(result))
  return result.value
}
const errors = []
page.on('pageerror', error => errors.push(error.message))
let createdId
try {
  await page.goto(url)
  let measurement
  if (process.argv.includes('--live')) {
    createdId = (await rpc('session/create', { request: { agentPreset: 'data-agent' } })).sessionId
    await rpc('session/prompt', { request: {
      requestId: crypto.randomUUID(), sessionId: createdId, mode: 'queue',
      content: [{ type: 'text', text: '请仅回答收到，不要调用工具。' }], clientTimeZone: 'Asia/Shanghai',
    } })
    let trace
    const deadline = Date.now() + 180000
    while (Date.now() < deadline) {
      trace = await (await page.request.get(`${origin}/api/trace/export?sessionId=${createdId}`)).json()
      if (trace.sessions?.[0]?.events?.some(event => event.type === 'turn/end')) break
      await new Promise(accept => setTimeout(accept, 1000))
    }
    const session = trace.sessions[0]
    assert(session.events.some(event => event.type === 'turn/end'), 'The owned analysis did not finish.')
    const request = session.requests[0].snapshot.request
    const tools = request.tools.map(tool => tool.name)
    assert.equal(tools.length, 7)
    for (const absent of ['analyze_data', 'import_dataset', 'render_chart', 'list_databases', 'present', 'subagent', 'workflow', 'bash', 'write', 'edit']) assert(!tools.includes(absent))
    const system = request.messages.filter(message => message.role === 'system')
    const text = JSON.stringify(system)
    for (const absent of ['powered by DeepSeek Harness', 'implementation checkout', 'HMR receiver', 'Prefer showing']) assert(!text.includes(absent))
    assert(text.includes('版本化 MD') && text.includes('完整 resultId'))
    const end = session.events.find(event => event.type === 'data-agent/request-end')
    assert.equal(end.data.status, 'completed')
    measurement = { tools, systemChars: text.length, toolsChars: JSON.stringify(request.tools).length, usage: end.data.usage }
    await writeFile(join(run, 'after.json'), JSON.stringify(measurement, null, 2))
    await rpc('workspace/archiveSession', { request: { sessionId: createdId } })
    createdId = undefined
  }
  await page.reload()
  await page.locator('.session-record').first().waitFor()
  if (!await page.locator(`.session-record[data-session-id="${historical.sessionId}"]`).count()) {
    for (const record of await page.locator('.session-record').all()) {
      const sessionId = await record.getAttribute('data-session-id')
      const trace = await (await page.request.get(`${origin}/api/trace/export?sessionId=${sessionId}`)).json()
      const first = trace.sessions?.[0]?.requests?.find(item => item.snapshot)
      if (first) { historical = { sessionId, requestId: first.requestId }; break }
    }
  }
  await page.locator(`.session-record[data-session-id="${historical.sessionId}"] .session-item`).click()
  const finalAnswer = page.locator('.msg-assistant').last()
  await finalAnswer.locator('.answer-actions').waitFor()
  assert(!/\n证据\s*[:：]/u.test(await finalAnswer.innerText()))
  const original = await (await page.request.get(`${origin}/api/trace/export?sessionId=${historical.sessionId}`)).json()
  let reportRequests = 0
  page.on('request', request => { if (request.url().endsWith('/api/session/prompt')) reportRequests++ })
  for (const format of ['md', 'html', 'pdf']) {
    await finalAnswer.getByRole('combobox', { name: '报告格式', exact: true }).selectOption(format)
    assert.equal(await finalAnswer.getByRole('combobox').inputValue(), format)
  }
  assert(await finalAnswer.getByRole('button', { name: '生成报告', exact: true }).isEnabled())
  for (const size of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }, { width: 1440, height: 1000 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size)
    await finalAnswer.locator('.answer-actions').scrollIntoViewIfNeeded()
    const bounds = await finalAnswer.locator('.answer-actions').boundingBox()
    assert(bounds.x >= 0 && bounds.x + bounds.width <= size.width && bounds.y + bounds.height <= size.height)
    await page.screenshot({ path: join(run, `report-choices-${size.width}.png`) })
  }
  assert.equal(reportRequests, 0, 'Choosing a format must not automatically launch a model request.')
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.locator('.execution-step > summary').first().click()
  await page.locator('.execution-request').first().click()
  await page.locator('.request-inspector footer').waitFor()
  const sections = [['system', '提示词'], ['context', '上下文'], ['tools', '可用工具'], ['info', '请求信息'], ['raw', '原文']]
  const lengths = {}
  for (const [section, label] of sections) {
    const fullResponse = await page.request.get(`${origin}/api/trace/request-download?${new URLSearchParams({ sessionId: historical.sessionId, requestId: historical.requestId, section })}`)
    assert.equal(fullResponse.status(), 200)
    const full = await fullResponse.text()
    lengths[section] = full.length
    await page.locator('.request-inspector nav').getByRole('button', { name: label, exact: true }).click()
    await page.locator('.request-inspector footer').waitFor()
    assert.equal(await page.getByRole('button', { name: '展开全文', exact: true }).count(), 0)
    assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).count(), 0)
    await page.getByText('完整内容', { exact: false }).waitFor()
    assert((await page.locator('.request-inspector footer').innerText()).includes(String(full.length)))
    if (['tools', 'info', 'raw'].includes(section)) {
      await page.waitForFunction(expected => document.querySelector('.request-content > pre')?.textContent === expected, full)
      JSON.parse(await page.locator('.request-content > pre').textContent())
    }
    if (section === 'tools') {
      const tools = JSON.parse(full)
      assert.equal(await page.locator('.request-tools tbody tr').count(), tools.length)
      const names = await page.locator('.request-tools tbody th').allTextContents()
      assert.deepEqual(names, tools.map(tool => tool.name))
      assert((await page.locator('.request-tools').innerText()).includes('只读 SQL'))
      await page.screenshot({ path: join(run, 'tools-purposes.png') })
    }
    const [download] = await Promise.all([
      page.waitForEvent('download'), page.getByRole('link', { name: '下载完整内容', exact: true }).click(),
    ])
    const saved = join(run, `${section}.${['system', 'context'].includes(section) ? 'md' : 'json'}`)
    await download.saveAs(saved)
    assert.equal(await readFile(saved, 'utf8'), full)
    await page.locator('.request-content').evaluate(element => { element.scrollTop = element.scrollHeight })
    const geometry = await page.locator('.request-inspector').evaluate(element => {
      const content = element.querySelector('.request-content')
      const footer = element.querySelector('footer').getBoundingClientRect()
      const bounds = content.getBoundingClientRect()
      const nestedScroll = [...content.querySelectorAll('pre')].some(pre =>
        getComputedStyle(pre).overflowY !== 'visible' || getComputedStyle(pre).maxHeight !== 'none')
      return { bottom: bounds.bottom, footerTop: footer.top, footerBottom: footer.bottom, height: bounds.height, reachedEnd: content.scrollTop + content.clientHeight >= content.scrollHeight - 1, nestedScroll }
    })
    assert(geometry.height > 100 && geometry.bottom <= geometry.footerTop + 1 && geometry.footerBottom <= 1000 && geometry.reachedEnd && !geometry.nestedScroll)
    await page.screenshot({ path: join(run, `${section}-end.png`) })
  }
  const longRequest = original.sessions[0].requests.filter(item => item.snapshot)
    .sort((left, right) => JSON.stringify(right.snapshot.request.messages).length - JSON.stringify(left.snapshot.request.messages).length)[0]
  const contextResponse = await page.request.get(`${origin}/api/trace/request-download?${new URLSearchParams({ sessionId: historical.sessionId, requestId: longRequest.requestId, section: 'context' })}`)
  assert.equal(contextResponse.status(), 200)
  const longContext = await contextResponse.text()
  assert(longContext.length > 12000, 'The historical analysis must include a context beyond the old page limit.')
  await page.locator('.request-inspector').getByRole('button', { name: '关闭', exact: true }).click()
  await page.locator('.execution-step').evaluateAll(elements => { for (const element of elements) element.open = true })
  await page.locator(`.execution-request[data-request-id="${longRequest.requestId}"]`).click()
  await page.locator('.request-inspector nav').getByRole('button', { name: '上下文', exact: true }).click()
  await page.locator('.request-inspector footer').getByText(String(longContext.length), { exact: false }).waitFor()
  const messages = longRequest.snapshot.request.messages
  await page.locator('.request-content .md').getByRole('heading', { name: `${messages.length}. ${messages.at(-1).role}`, exact: true }).waitFor()
  assert.equal(await page.getByRole('button', { name: '下一页', exact: true }).count(), 0)
  await page.locator('.request-content').evaluate(element => { element.scrollTop = element.scrollHeight })
  await page.screenshot({ path: join(run, 'long-context-end.png') })
  const [contextDownload] = await Promise.all([
    page.waitForEvent('download'), page.getByRole('link', { name: '下载完整内容', exact: true }).click(),
  ])
  const contextPath = join(run, 'long-context.md')
  await contextDownload.saveAs(contextPath)
  assert.equal(await readFile(contextPath, 'utf8'), longContext)
  await page.locator('.request-inspector nav').getByRole('button', { name: '原文', exact: true }).click()
  await page.locator('.request-content > pre').waitFor()
  const layouts = []
  for (const size of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }, { width: 1440, height: 1000 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size)
    const geometry = await page.locator('.request-inspector').evaluate(element => ({
      width: element.getBoundingClientRect().width,
      footerBottom: element.querySelector('footer').getBoundingClientRect().bottom,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }))
    assert(!geometry.overflow && geometry.footerBottom <= size.height)
    layouts.push({ size, geometry })
    await page.screenshot({ path: join(run, `desktop-${size.width}.png`) })
  }
  await page.getByRole('button', { name: '宽屏详情', exact: true }).click()
  assert((await page.locator('.request-inspector').boundingBox()).width >= 1880)
  await page.screenshot({ path: join(run, 'wide.png') })
  await page.locator('.request-inspector').getByRole('button', { name: '关闭', exact: true }).press('Escape')
  assert.equal(await page.locator('.request-inspector').count(), 0)
  const anonymous = await browser.newContext()
  assert.equal((await anonymous.request.get(`${origin}/api/trace/request-download?sessionId=${historical.sessionId}&requestId=${historical.requestId}`)).status(), 401)
  await anonymous.close()
  assert.deepEqual(errors, [])
  await writeFile(join(run, 'summary.json'), JSON.stringify({ measurement, lengths, longContextChars: longContext.length, layouts, errors, auth: 401 }, null, 2))
  console.log(JSON.stringify({ run, sessionId: historical.sessionId, measurement, lengths, longContextChars: longContext.length, widths: layouts.map(item => item.size.width), errors }))
} catch (error) {
  await page.screenshot({ path: join(run, 'failure.png') }).catch(() => {})
  console.error((await page.locator('body').innerText()).slice(-1800))
  throw error
} finally {
  try {
    if (createdId) {
      await rpc('session/cancel', { request: { sessionId: createdId } })
      const deadline = Date.now() + 20000
      while (Date.now() < deadline) {
        const trace = await (await page.request.get(`${origin}/api/trace/export?sessionId=${createdId}`)).json()
        if (trace.sessions?.[0]?.events?.some(event => event.type === 'turn/end')) break
        await new Promise(accept => setTimeout(accept, 250))
      }
      await rpc('workspace/archiveSession', { request: { sessionId: createdId } })
    }
  } finally {
    await context.close()
    await browser.close()
  }
}
