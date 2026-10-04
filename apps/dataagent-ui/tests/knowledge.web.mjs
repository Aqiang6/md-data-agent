/** Authenticated knowledge-library workflows through an isolated real dsh profile. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'

const repo = resolve('.')
if (existsSync(join(repo, '.env'))) process.loadEnvFile(join(repo, '.env'))
const run = await mkdtemp(join(repo, '.playwright-mcp', 'data-knowledge-'))
const { chromium } = createRequire(join(repo, 'apps/web/package.json'))('playwright')
const env = { ...process.env, DSH_HOME: join(run, 'home'), DSH_AGENTS_HOME: join(run, 'agents') }
execFileSync(process.execPath, ['--import', 'tsx/esm', 'scripts/prepare-data-agent-profile.ts'], { cwd: repo, windowsHide: true, env, stdio: 'pipe' })
const overlay = join(run, 'knowledge.patch.yml')
await writeFile(overlay, `- id: data-agent\n  config:\n    artifactsDirectory: ${JSON.stringify(join(run, 'evidence'))}\n    mysqlDatabases: [12306-forAnalyse]\n`)
const server = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'data-agent', '--patch', 'apps/web/tests/pin-browse-picker.overlay.yml', '--patch', overlay, '--port', '0', '--no-open'], {
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
  const origin = new URL(url).origin
  browser = await chromium.launch({ headless: true })
  await mkdir(join(run, 'videos'))
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', recordVideo: { dir: join(run, 'videos'), size: { width: 1440, height: 1000 } } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  const rpc = async (method, args) => {
    const response = await page.request.post(`${origin}/api/${method}`, { data: { type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } } })
    const result = (await response.json()).result
    assert(result?.ok, JSON.stringify(result))
    return result.value
  }
  await page.getByText('暂无分析记录', { exact: true }).waitFor()
  const sourcePicker = page.getByRole('combobox', { name: '选择数据源', exact: true })
  await sourcePicker.locator('option[value="shop.db"]').waitFor({ state: 'attached' })
  await page.route('**/api/session/create', route => route.abort('failed'), { times: 1 })
  await page.locator('.source-row').filter({ hasText: 'shop.db' }).click()
  await page.locator('.error-bar').waitFor()
  assert((await page.locator('.error-bar').innerText()).includes('创建会话失败'))
  assert.equal(await page.locator('.session-record').count(), 0)
  await sourcePicker.selectOption('shop.db')
  await page.locator('.session-record.active').waitFor()
  await page.waitForFunction(() => document.querySelector('.db-picker select')?.value === 'shop.db')
  const created = { sessionId: await page.locator('.session-record.active').getAttribute('data-session-id') }
  assert(created.sessionId)
  assert.equal((await rpc('session/list', { _request: {} })).items.length, 1)
  const initialProjection = await rpc('session/projections', { request: { sessionId: created.sessionId } })
  assert.equal(initialProjection.values.glmDb.selected, 'shop.db')
  assert.equal(await page.locator('.error-bar').count(), 0)
  await page.screenshot({ path: join(run, 'home-source-selection.png') })
  await page.reload()
  await page.waitForFunction(() => document.querySelector('.db-picker select')?.value === 'shop.db')
  await page.locator('.source-row').filter({ hasText: 'shop.db' }).click()
  assert.equal((await rpc('session/list', { _request: {} })).items.length, 1)
  const initialHistory = await rpc('session/page', { request: { address: { kind: 'session', sessionId: created.sessionId }, throughSeq: initialProjection.asOfSeq, maxMessages: 400 } })
  const selection = initialHistory.records.find(record => record.event.type === 'command/run' && record.event.data.name === 'db')
  assert.equal(selection?.event.data.args.trim(), 'shop.db')
  assert(initialHistory.records.some(record => record.event.type === 'command/done' && record.event.data.commandId === selection.event.data.commandId && record.event.data.kind === 'success'))
  await writeFile(join(run, 'source-selection-trajectory.json'), JSON.stringify(initialHistory, null, 2))
  let selectionVerified = false
  const open = async () => {
    await page.reload()
    await page.locator('.session-item').first().waitFor()
    await page.locator('.side-foot').getByRole('button', { name: '数据源管理', exact: true }).click()
    await page.locator('.manager-source > button').filter({ hasText: 'shop.db' }).click()
    if (!selectionVerified) {
      await page.locator('.table-summary').first().waitFor()
      assert.equal(await page.locator('.table-list input[type="checkbox"]').count(), 0)
      await page.getByRole('button', { name: '应用数据库选择', exact: true }).click()
      await page.getByText('数据库选择已应用到当前分析', { exact: true }).waitFor()
      const response = await page.request.get(`${origin}/api/data-agent/scope?sessionId=${encodeURIComponent(created.sessionId)}`)
      const { scope } = await response.json()
      assert.equal(scope.version, 2)
      assert(scope.sources.every(source => !Object.hasOwn(source, 'tables')))
      await page.screenshot({ path: join(run, 'database-selection.png') })
      selectionVerified = true
    }
    await page.getByRole('button', { name: '业务知识库', exact: true }).click()
    await page.getByLabel('添加 MD', { exact: true }).waitFor()
    await page.waitForFunction(() => !!document.querySelector('.knowledge-toolbar input[type="file"]:not(:disabled)'))
  }
  await open()
  const file = (name, text) => ({ name, mimeType: 'text/markdown', buffer: Buffer.from(text) })
  const add = async files => {
    await page.getByLabel('添加 MD', { exact: true }).setInputFiles(files)
    await page.getByText('知识库已更新', { exact: true }).waitFor()
  }
  const metric = '# KB_METRIC_ALPHA\n\n演示指标 Alpha 的单位是分。'
  const refund = '# KB_REFUND_BETA\n\n演示指标 Beta 必须排除撤销记录。'
  await add([file('metric-a.md', metric), file('refund-b.md', refund)])
  assert.equal(await page.locator('.knowledge-row').count(), 2)
  await open()
  assert.equal(await page.locator('.knowledge-row').count(), 2)
  await page.locator('.knowledge-select').filter({ hasText: 'metric-a.md' }).click()
  await page.locator('.schema-document').getByText('演示指标 Alpha 的单位是分。', { exact: true }).waitFor()
  const downloadEvent = page.waitForEvent('download')
  await page.getByLabel('下载文档', { exact: true }).click()
  const downloaded = await downloadEvent
  assert.equal(downloaded.suggestedFilename(), 'metric-a.md')
  assert.equal(await readFile(await downloaded.path(), 'utf8'), metric)
  await page.getByLabel('替换文档', { exact: true }).setInputFiles(file('metric-a.md', '# KB_METRIC_ALPHA\n\n演示指标 Alpha 的单位是元。'))
  await page.getByText('知识库已更新', { exact: true }).waitFor()
  await page.locator('.schema-document').getByText('演示指标 Alpha 的单位是元。', { exact: true }).waitFor()
  assert.equal(await page.locator('.knowledge-row').count(), 2)
  await page.getByLabel('生效 refund-b.md', { exact: true }).uncheck()
  await page.getByText('知识库已更新', { exact: true }).waitFor()
  await open()
  assert.equal(await page.getByLabel('生效 refund-b.md', { exact: true }).isChecked(), false)
  await page.getByLabel('生效 refund-b.md', { exact: true }).check()
  await page.getByText('知识库已更新', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Schema 知识库', exact: true }).click()
  await page.getByText('暂无文档', { exact: true }).waitFor()
  assert.equal(await page.locator('.knowledge-row').count(), 0)
  await add([file('fields.md', '# Fields\n\n额外字段说明。'), file('relationships.md', '# Relationships\n\n关联仍须实际字段确认。')])
  assert.equal(await page.locator('.knowledge-row').count(), 2)
  const fields = page.getByLabel('生效 fields.md', { exact: true })
  assert.equal(await fields.isDisabled(), false)
  await fields.uncheck()
  await page.getByText('知识库已更新', { exact: true }).waitFor()
  await fields.check()
  await page.getByText('知识库已更新', { exact: true }).waitFor()
  await page.getByRole('button', { name: '业务知识库', exact: true }).click()
  await page.locator('.knowledge-select').filter({ hasText: 'metric-a.md' }).click()
  const layouts = []
  for (const size of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }, { width: 1440, height: 1000 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size)
    const geometry = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, workspace: document.querySelector('.knowledge-workspace').getBoundingClientRect().toJSON(), list: document.querySelector('.knowledge-list').getBoundingClientRect().toJSON(), detail: document.querySelector('.knowledge-detail').getBoundingClientRect().toJSON(), toolbar: [...document.querySelectorAll('.knowledge-toolbar > *')].map(item => item.getBoundingClientRect().toJSON()) }))
    assert(!geometry.overflow)
    assert(geometry.list.right <= geometry.detail.x + 1)
    assert(geometry.toolbar.every(item => item.right <= size.width + 1))
    assert(geometry.toolbar.every((item, index) => !index || geometry.toolbar[index - 1].right <= item.x + 1))
    layouts.push({ size, geometry })
    await page.screenshot({ path: join(run, `knowledge-${size.width}.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.locator('.manager-source > button').filter({ hasText: /12306-foranalyse/iu }).click()
  await page.locator('.knowledge-select').filter({ hasText: '12306-source-business.md' }).waitFor()
  assert.equal(await page.locator('.knowledge-row').count(), 2)
  await page.locator('.knowledge-select').filter({ hasText: '12306-analysis-business.md' }).click()
  assert.equal(await page.getByLabel('替换文档', { exact: true }).count(), 0)
  assert.equal(await page.getByLabel('移除文档', { exact: true }).count(), 0)
  await page.screenshot({ path: join(run, 'railway-references.png') })
  await page.locator('.manager-source > button').filter({ hasText: 'shop.db' }).click()
  if (process.argv.includes('--live')) {
    await page.getByRole('button', { name: '返回分析', exact: true }).click()
    await page.locator('.composer > textarea').fill('请先 read 读取当前 shop.db 业务资料中的 metric-a.md 和 refund-b.md。说明 KB_METRIC_ALPHA 与 KB_REFUND_BETA 的定义，不要查询数据库或读取其他文件。')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.locator('.msg-assistant').first().waitFor({ timeout: 180000 })
    await page.getByRole('button', { name: '发送', exact: true }).waitFor({ timeout: 180000 })
    const trace = await (await page.request.get(`${origin}/api/trace/export?sessionId=${created.sessionId}`)).json()
    const events = trace.sessions[0].events
    const readings = events.filter(event => event.type === 'tool/call' && event.data.name === 'read')
    assert(readings.length >= 2)
    const results = events.filter(event => event.type === 'tool/result')
    assert(JSON.stringify(results).includes('演示指标 Alpha 的单位是元。'))
    assert(JSON.stringify(results).includes('演示指标 Beta 必须排除撤销记录。'))
    await writeFile(join(run, 'trajectory.json'), JSON.stringify(trace, null, 2))
    await page.screenshot({ path: join(run, 'live-knowledge-reading.png') })
    await page.locator('.side-foot').getByRole('button', { name: '数据源管理', exact: true }).click()
    await page.locator('.manager-source > button').filter({ hasText: 'shop.db' }).click()
    await page.getByRole('button', { name: '业务知识库', exact: true }).click()
  }
  await page.locator('.knowledge-select').filter({ hasText: 'metric-a.md' }).click()
  await page.getByLabel('移除文档', { exact: true }).click()
  await page.getByRole('button', { name: '确认移除', exact: true }).click()
  await page.getByText('文档已移除，历史分析证据保留', { exact: true }).waitFor()
  assert.equal(await page.locator('.knowledge-row').count(), 1)
  await open()
  assert.equal(await page.locator('.knowledge-row').count(), 1)
  const anonymous = await browser.newContext()
  const unauthorized = await anonymous.request.get(`${origin}/api/data-agent/knowledge?sessionId=${created.sessionId}&database=shop.db&category=business`)
  assert.equal(unauthorized.status(), 401)
  await anonymous.close()
  assert.deepEqual(errors, [])
  await writeFile(join(run, 'summary.json'), JSON.stringify({ layouts, errors, live: process.argv.includes('--live'), auth: unauthorized.status() }, null, 2))
  console.log(JSON.stringify({ run, live: process.argv.includes('--live'), desktopWidths: layouts.map(item => item.size.width), errors }))
} catch (error) {
  const page = context?.pages()[0]
  if (page) {
    await page.screenshot({ path: join(run, 'failure.png') })
    console.error((await page.locator('body').innerText()).slice(-5000))
  }
  console.error(log.replace(/token=[^\s]+/gu, 'token=[redacted]').slice(-2200))
  throw error
} finally {
  await context?.close()
  await browser?.close()
  if (server.exitCode === null) server.kill('SIGINT')
  const timeout = setTimeout(() => { if (server.exitCode === null) server.kill('SIGTERM') }, 10000)
  await exited
  clearTimeout(timeout)
}
