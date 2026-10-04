/** Real-profile deletion, stream updates, desktop layout and restart persistence checks. */
import assert from 'node:assert/strict'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const repo = resolve('.')
if (existsSync(join(repo, '.env'))) process.loadEnvFile(join(repo, '.env'))
const run = await mkdtemp(join(repo, '.playwright-mcp', 'analysis-history-'))
const workspace = await mkdtemp(join(tmpdir(), 'analysis-history-'))
const { chromium } = createRequire(join(repo, 'apps/web/package.json'))('playwright')
const env = { ...process.env, DSH_HOME: join(run, 'home'), DSH_AGENTS_HOME: join(run, 'agents') }
execFileSync(process.execPath, ['--import', 'tsx/esm', 'scripts/prepare-data-agent-profile.ts'], { cwd: repo, windowsHide: true, env, stdio: 'pipe' })
const overlay = join(run, 'history.patch.yml')
await writeFile(overlay, `- id: data-agent\n  config:\n    artifactsDirectory: ${JSON.stringify(join(run, 'evidence'))}\n`)
let server
let exited
let log = ''
let browser
let context
const launch = () => {
  server = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', '--profile', 'data-agent', '--patch', 'apps/web/tests/pin-browse-picker.overlay.yml', '--patch', overlay, '--port', '0', '--no-open'], {
    cwd: repo, windowsHide: true, env, stdio: ['ignore', 'pipe', 'pipe'],
  })
  exited = new Promise(accept => server.once('exit', accept))
  log = ''
  return new Promise((accept, reject) => {
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
}
const stop = async () => {
  if (!server) return
  if (server.exitCode === null) server.kill('SIGINT')
  const timeout = setTimeout(() => { if (server.exitCode === null) server.kill('SIGTERM') }, 10000)
  await exited
  clearTimeout(timeout)
}

try {
  let url = await launch()
  browser = await chromium.launch({ headless: true })
  await mkdir(join(run, 'videos'))
  context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN', recordVideo: { dir: join(run, 'videos'), size: { width: 1440, height: 1000 } } })
  const page = await context.newPage()
  const errors = []
  page.on('pageerror', error => errors.push(error.message))
  await page.goto(url)
  const rpc = async (method, args) => {
    const response = await page.request.post(`${new URL(url).origin}/api/${method}`, { data: { type: 'client-request', rpcId: crypto.randomUUID(), method, payload: { args } } })
    const result = (await response.json()).result
    assert(result?.ok, JSON.stringify(result))
    return result.value
  }
  const ids = []
  const legacy = (await rpc('session/create', { request: { agentPreset: 'standard', cwd: workspace } })).sessionId
  for (let index = 0; index < 3; index++) ids.push((await rpc('session/create', { request: { agentPreset: 'data-agent', cwd: workspace } })).sessionId)
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.session-record').length === 3)
  assert.equal(await page.locator(`.session-record[data-session-id="${legacy}"]`).count(), 0)
  const activeId = await page.locator('.session-record.active').getAttribute('data-session-id')
  assert(ids.includes(activeId))
  const row = id => page.locator(`.session-record[data-session-id="${id}"]`)
  if (process.argv.includes('--live')) {
    await page.locator('.composer > textarea').fill('不要查询数据。请先调用 ask 询问本次指标（订单量、退款率），等待我回答后再分析。不要自行替我选择。')
    await page.getByRole('button', { name: '发送', exact: true }).click()
    await page.locator('.questions').waitFor({ timeout: 180000 })
    assert(await row(activeId).locator('.session-delete').isDisabled())
    const denied = await page.request.post(`${new URL(url).origin}/api/workspace/archiveSession`, { data: { type: 'client-request', rpcId: crypto.randomUUID(), method: 'workspace/archiveSession', payload: { args: { request: { sessionId: activeId } } } } })
    assert.equal((await denied.json()).result.error.code, 'workspace/session-active')
    await page.screenshot({ path: join(run, 'running-protected.png') })
    await page.getByRole('button', { name: '停止', exact: true }).click()
    await page.getByRole('button', { name: '发送', exact: true }).waitFor({ timeout: 45000 })
    await page.waitForFunction(id => !document.querySelector(`[data-session-id="${id}"] .session-delete`).disabled, activeId)
    const trace = await (await page.request.get(`${new URL(url).origin}/api/trace/export?sessionId=${activeId}`)).json()
    await writeFile(join(run, 'trajectory.json'), JSON.stringify(trace, null, 2))
  }
  await row(activeId).locator('.session-delete').click()
  await page.getByRole('button', { name: '取消操作', exact: true }).press('Escape')
  assert.equal(await page.locator('.session-delete-confirm').count(), 0)
  await row(activeId).locator('.session-delete').click()
  await page.locator('.brand').click()
  assert.equal(await page.locator('.session-delete-confirm').count(), 0)
  await row(activeId).locator('.session-delete').click()
  const layouts = []
  for (const size of [{ width: 1024, height: 768 }, { width: 1280, height: 800 }, { width: 1440, height: 1000 }, { width: 1920, height: 1080 }]) {
    await page.setViewportSize(size)
    const geometry = await page.evaluate(() => ({ overflow: document.documentElement.scrollWidth > innerWidth, sidebar: document.querySelector('.sidebar').getBoundingClientRect().toJSON(), buttons: [...document.querySelectorAll('.session-record button')].map(item => item.getBoundingClientRect().toJSON()) }))
    assert(!geometry.overflow)
    assert(geometry.buttons.every(item => item.x >= geometry.sidebar.x && item.right <= geometry.sidebar.right + 1))
    layouts.push({ size, geometry })
    await page.screenshot({ path: join(run, `delete-confirm-${size.width}.png`) })
  }
  await page.setViewportSize({ width: 1440, height: 1000 })
  await page.route('**/api/workspace/archiveSession', route => route.abort('failed'), { times: 1 })
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await page.getByText('删除失败，记录已保留', { exact: true }).waitFor()
  assert.equal(await page.locator('.session-record').count(), 3)
  assert.equal(await row(activeId).count(), 1)
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await row(activeId).waitFor({ state: 'detached' })
  await page.getByText('分析记录已删除', { exact: true }).waitFor()
  assert.equal(await page.locator('.session-record').count(), 2)
  const nextId = await page.locator('.session-record.active').getAttribute('data-session-id')
  assert(nextId && nextId !== activeId)
  await page.reload()
  await page.waitForFunction(() => document.querySelectorAll('.session-record').length === 2)
  assert.equal(await row(activeId).count(), 0)
  const peer = await context.newPage()
  await peer.goto(url)
  await peer.waitForFunction(() => document.querySelectorAll('.session-record').length === 2)
  const inactiveId = ids.find(id => id !== activeId && id !== nextId)
  await row(inactiveId).locator('.session-delete').click()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await row(inactiveId).waitFor({ state: 'detached' })
  assert.equal(await page.locator('.session-record.active').getAttribute('data-session-id'), nextId)
  await peer.locator(`.session-record[data-session-id="${inactiveId}"]`).waitFor({ state: 'detached' })
  await row(nextId).locator('.session-delete').click()
  await page.getByRole('button', { name: '确认删除', exact: true }).click()
  await page.getByText('暂无分析记录', { exact: true }).waitFor()
  assert.equal(await page.locator('.session-record.active').count(), 0)
  await page.getByRole('button', { name: '新建分析', exact: true }).click()
  await page.locator('.session-record.active').waitFor()
  const newId = await page.locator('.session-record.active').getAttribute('data-session-id')
  assert(!ids.includes(newId))
  await peer.close()
  await stop()
  url = await launch()
  await page.goto(url)
  await page.waitForFunction(() => document.querySelectorAll('.session-record').length === 1)
  assert.equal(await page.locator('.session-record.active').getAttribute('data-session-id'), newId)
  assert.equal(await page.locator(`.session-record[data-session-id="${legacy}"]`).count(), 0)
  const complete = await rpc('session/list', { _request: {} })
  assert(ids.every(id => complete.items.some(item => item.sessionId === id)))
  await page.screenshot({ path: join(run, 'after-restart.png') })
  const anonymous = await browser.newContext()
  const denied = await anonymous.request.post(`${new URL(url).origin}/api/workspace/archiveSession`, { data: { type: 'client-request', rpcId: crypto.randomUUID(), method: 'workspace/archiveSession', payload: { args: { request: { sessionId: newId } } } } })
  assert.equal(denied.status(), 401)
  await anonymous.close()
  assert.deepEqual(errors, [])
  await writeFile(join(run, 'summary.json'), JSON.stringify({ ids, newId, layouts, errors, live: process.argv.includes('--live'), restart: true, retainedLogs: true, auth: denied.status() }, null, 2))
  console.log(JSON.stringify({ run, live: process.argv.includes('--live'), widths: layouts.map(item => item.size.width), restart: true, errors }))
} catch (error) {
  const page = context?.pages()[0]
  if (page) {
    await page.screenshot({ path: join(run, 'failure.png') })
    console.error((await page.locator('body').innerText()).slice(-4000))
  }
  console.error(log.replace(/token=[^\s]+/gu, 'token=[redacted]').slice(-1800))
  throw error
} finally {
  await context?.close()
  await browser?.close()
  await stop()
}
