/** Complete immutable request sections and lossless bounded pages through the authenticated route registry. */
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { z } from 'zod'
import { Context } from '@deepseek-ai/cordis'
import { HostConnectionService } from '@deepseek-ai/dsh-client-connection/src/rpc-host.ts'
import type { BrowserAuth } from '@deepseek-ai/dsh-client-connection/src/browser-auth.ts'
import { Config } from '../src/config.ts'
import { DataCore } from '../src/data-core.ts'
import { requestDetail, requestSection } from '../src/trace.ts'
import { installDataApi } from '../src/web-api.ts'

let root: string
let data: DataCore
const requestId = randomUUID()
const snapshot = {
  version: 1, scope: 'harness-request', inputThroughSeq: 17,
  request: {
    provider: 'fixture', model: 'fixture', temperature: 0.2,
    messages: [
      { role: 'system', content: [{ type: 'text', text: '# Rules\n\n' + 'Long evidence. '.repeat(1000) + 'FINAL SYSTEM' }] },
      { role: 'user', content: [{ type: 'text', text: 'Read the data.' }, { type: 'image', url: 'attachment:sample' }] },
    ],
    tools: [{ name: 'query_database', description: 'Read-only '.repeat(2000), parameters: { type: 'object' } }],
  },
  header: { prompt: 'Header context '.repeat(2000) + 'FINAL HEADER' },
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'data-request-'))
  data = new DataCore(new Config(Object.assign(Config(), { artifactsDirectory: root, uiDist: '' })))
  const directory = join(data.root('request-test'), 'requests')
  await mkdir(directory, { recursive: true })
  await writeFile(join(directory, `${requestId}.json`), JSON.stringify(snapshot))
})
afterEach(async () => { await rm(root, { recursive: true, force: true }) })

it.each(['system', 'context', 'tools', 'info', 'raw'])('reads every character of %s without changing the stored request', async (section) => {
  const complete = await requestSection(data, 'request-test', requestId, section)
  expect(complete.raw.length).toBeGreaterThan(data.config.documentPageChars)
  let cursor: number | null = 0
  let joined = ''
  while (cursor !== null) {
    const page = await requestDetail(data, 'request-test', requestId, cursor, section)
    expect(page.sha256).toBe(complete.sha256)
    expect(page.inputThroughSeq).toBe(17)
    expect(page.offset).toBe(joined.length)
    expect(page.raw.length).toBeLessThanOrEqual(data.config.documentPageChars)
    joined += page.raw
    cursor = page.nextOffset
  }
  expect(joined).toBe(complete.raw)
  if (section === 'tools') expect(JSON.parse(joined)).toEqual(snapshot.request.tools)
  if (section === 'info') expect(z.object({ header: z.unknown() }).parse(JSON.parse(joined)).header).toEqual(snapshot.header)
  if (section === 'raw') expect(JSON.parse(joined)).toEqual(snapshot)
})

it('rejects invalid identifiers, sections, out-of-range cursors and other session paths', async () => {
  await expect(requestSection(data, 'request-test', '../secret')).rejects.toThrow('identifier')
  await expect(requestSection(data, 'request-test', requestId, '../raw')).rejects.toThrow('section')
  for (const offset of [-1, 0.5, NaN, Infinity, 99999999])
    await expect(requestDetail(data, 'request-test', requestId, offset)).rejects.toThrow('cursor')
  await expect(requestSection(data, 'another-session', requestId)).rejects.toThrow('ENOENT')
})

it('downloads full JSON or MD including the final page, and rejects invalid downloads', async () => {
  const ctx = new Context()
  try {
    const connection = new HostConnectionService(ctx, [], {} as BrowserAuth)
    installDataApi(ctx, data)
    const handler = connection.createSharedFetchHandler('/api')
    for (const section of ['system', 'context', 'tools', 'info', 'raw']) {
      const response = await handler.fetch(new Request(`http://host/api/trace/request-download?sessionId=request-test&requestId=${requestId}&section=${section}`))
      expect(response.status).toBe(200)
      expect(await response.text()).toBe((await requestSection(data, 'request-test', requestId, section)).raw)
      expect(response.headers.get('content-disposition')).toContain(`${section}.${['system', 'context'].includes(section) ? 'md' : 'json'}`)
      expect(response.headers.get('x-content-type-options')).toBe('nosniff')
    }
    expect((await handler.fetch(new Request(`http://host/api/trace/request-download?sessionId=request-test&requestId=${requestId}&section=invalid`))).status).toBe(400)
  } finally { await ctx.fiber.dispose() }
})
