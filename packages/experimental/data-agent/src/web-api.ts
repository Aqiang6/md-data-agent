/** Authenticated read-only Data Agent inspection and artifact routes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-session-query'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { DataCore } from './data-core.ts'
import { readArtifact } from './reports.ts'
import { readRequest, requestDetail, requestSection } from './trace.ts'
import { z } from 'zod'
import { DocumentId } from './brand.ts'

const uploadInput = z.object({
  database: z.string(), filename: z.string(), markdown: z.string(),
  replace: z.object({
    id: z.string().regex(/^[a-f0-9]{20}$/u).transform(DocumentId),
    version: z.string().regex(/^[a-f0-9]{64}$/u),
  }).optional(),
})

/** Register routes through Connection's Host/Origin and browser authentication checks.
 * @param ctx - authenticated transport registry.
 * @param data - session evidence store.
 */
export function installDataApi(ctx: Context, data: DataCore): void {
  const register = (path: string, handler: (url: URL, signal: AbortSignal) => Promise<Response>): void => {
    ctx.connection.fetch.register({
      path,
      methods: ['GET'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          return await handler(new URL(request.url), request.signal)
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          )
        }
      },
    })
  }
  register('/api/data-agent/sources', async () => {
    const sources = await data.catalog.list()
    return Response.json({
      databases: sources.map(source => source.id),
      sources,
      connections: await data.catalog.connections(),
    })
  })
  register('/api/data-agent/scope', async (url) => {
    const id = url.searchParams.get('sessionId') ?? ''
    data.root(id)
    await data.restoreScope(id)
    return Response.json({ scope: data.scope(id) })
  })
  register('/api/data-agent/tables', async (url, signal) => {
    const id = url.searchParams.get('sessionId') ?? ''
    data.root(id)
    return Response.json(await data.metadata(id, url.searchParams.get('database') ?? '', signal,
      url.searchParams.get('full') !== '1'))
  })
  ctx.connection.fetch.register({
    path: '/api/data-agent/schema',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const id = url.searchParams.get('sessionId') ?? ''
        data.root(id)
        await data.restoreScope(id)
        const schema = await data.schema(
          id,
          url.searchParams.get('database') ?? '',
          request.signal,
          url.searchParams.get('full') !== '1',
        )
        return url.searchParams.get('download') === '1'
          ? new Response(schema.markdown, {
            headers: {
              'content-type': 'text/markdown; charset=utf-8',
              'content-disposition': 'attachment; filename="schema.md"',
              'x-content-type-options': 'nosniff',
            },
          })
          : Response.json(schema)
      } catch (error) {
        return Response.json(
          { error: error instanceof Error ? error.message : String(error) },
          { status: 400 },
        )
      }
    },
  })
  const post = (path: string, handler: (raw: unknown, signal: AbortSignal) => Promise<unknown>): void => {
    ctx.connection.fetch.register({
      path: `/api/data-agent/${path}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const text = await request.text()
          if (Buffer.byteLength(text) > data.config.maxSchemaBytes * 2 + 16_384)
            throw new Error('Configuration request exceeds the byte limit.')
          return Response.json(await handler(JSON.parse(text), request.signal))
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : String(error) },
            { status: 400 },
          )
        }
      },
    })
  }
  post('connections/test', (raw, signal) => data.catalog.test(raw, signal))
  post('connections/save', (raw, signal) => data.catalog.add(raw, signal))
  post('connections/remove', async (raw) => {
    const { id } = z.object({ id: z.uuid() }).parse(raw)
    await data.catalog.remove(id)
    return { removed: true }
  })
  post('databases/create', (raw, signal) => {
    const { connectionId, name } = z.object({ connectionId: z.uuid(), name: z.string() }).parse(raw)
    return data.catalog.createDatabase(connectionId, name, signal)
  })
  for (const category of ['schema', 'business'] as const)
    post(`${category}/upload`, async (raw) => {
      const body = uploadInput.parse(raw)
      const source = (await data.catalog.list()).find(item => item.id === body.database)
      if (!source) throw new Error('Unknown database for source knowledge.')
      const store = category === 'schema' ? data.schemas : data.businesses
      return store.uploadKnowledge(body.database, source.name, body.filename, body.markdown, body.replace)
    })
  register('/api/data-agent/business', async (url) => {
    const knowledge = await data.business(
      url.searchParams.get('sessionId') ?? '',
      url.searchParams.get('database') ?? '',
      false,
    )
    return url.searchParams.get('download') === '1'
      ? new Response(knowledge.markdown, {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': 'attachment; filename="business.md"',
          'x-content-type-options': 'nosniff',
        },
      })
      : Response.json(knowledge)
  })
  const knowledge = async (sessionId: string, database: string, category: 'schema' | 'business', signal: AbortSignal) =>
    category === 'business'
      ? data.business(sessionId, database, false)
      : data.schema(sessionId, database, signal, false)
  register('/api/data-agent/knowledge', async (url, signal) => {
    const category = z.enum(['schema', 'business']).parse(url.searchParams.get('category'))
    return Response.json(await knowledge(
      url.searchParams.get('sessionId') ?? '', url.searchParams.get('database') ?? '',
      category, signal,
    ))
  })
  post('knowledge/change', async (raw, signal) => {
    const body = z.object({
      sessionId: z.string(), database: z.string(), category: z.enum(['schema', 'business']),
      id: z.string().regex(/^[a-f0-9]{20}$/u), version: z.string().regex(/^[a-f0-9]{64}$/u),
      action: z.union([z.object({ enabled: z.boolean() }), z.object({ remove: z.literal(true) })]),
    }).parse(raw)
    const current = await knowledge(body.sessionId, body.database, body.category, signal)
    const document = current.documents.find(item => item.id === body.id)
    if (!document || document.version !== body.version)
      throw new Error('Document changed; refresh the knowledge library before editing it.')
    const source = (await data.catalog.list()).find(item => item.id === body.database)
    if (!source) throw new Error('Unknown database for source knowledge.')
    const store = body.category === 'schema' ? data.schemas : data.businesses
    await store.changeKnowledge(body.database, source.name, document, body.action)
    return { changed: true }
  })
  register('/api/data-agent/knowledge/download', async (url, signal) => {
    const category = z.enum(['schema', 'business']).parse(url.searchParams.get('category'))
    const current = await knowledge(
      url.searchParams.get('sessionId') ?? '', url.searchParams.get('database') ?? '',
      category, signal,
    )
    const document = current.documents.find(item => item.id === url.searchParams.get('id'))
    if (!document || document.version !== url.searchParams.get('version'))
      throw new Error('Document changed; refresh the knowledge library before downloading it.')
    return new Response(document.markdown, { headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(document.filename)}`,
      'x-content-type-options': 'nosniff',
    } })
  })
  register('/api/trace/request-detail', async url =>
    Response.json(
      await requestDetail(
        data,
        url.searchParams.get('sessionId') ?? '',
        url.searchParams.get('requestId') ?? '',
        Number(url.searchParams.get('offset') ?? 0),
        url.searchParams.get('section') ?? 'raw',
      ),
    ),
  )
  register('/api/trace/request-download', async (url) => {
    const section = url.searchParams.get('section') ?? 'raw'
    const complete = await requestSection(
      data, url.searchParams.get('sessionId') ?? '', url.searchParams.get('requestId') ?? '', section,
    )
    const markdown = section === 'system' || section === 'context'
    return new Response(complete.raw, { headers: {
      'content-type': markdown ? 'text/markdown; charset=utf-8' : 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="${complete.requestId}-${section}.${markdown ? 'md' : 'json'}"`,
      'x-content-type-options': 'nosniff',
    } })
  })
  register('/api/data-agent/artifact', async (url) => {
    const filename = url.searchParams.get('filename') ?? ''
    const content = await readArtifact(
      data,
      url.searchParams.get('sessionId') ?? '',
      url.searchParams.get('artifactId') ?? '',
      filename,
    )
    const mime = filename.endsWith('.html')
      ? 'text/html; charset=utf-8'
      : filename.endsWith('.pdf')
        ? 'application/pdf'
        : filename.endsWith('.svg')
          ? 'image/svg+xml'
          : 'text/plain; charset=utf-8'
    return new Response(new Uint8Array(content), {
      headers: {
        'content-type': mime,
        'content-disposition': `${url.searchParams.get('preview') === '1' ? 'inline' : 'attachment'}; filename="${filename}"`,
        'content-security-policy':
          "sandbox; default-src 'none'; style-src 'unsafe-inline'; img-src data: 'self'",
        'x-content-type-options': 'nosniff',
      },
    })
  })
  register('/api/trace/export', async (url) => {
    const sessionId = SessionId(url.searchParams.get('sessionId') ?? '')
    data.root(sessionId)
    const visited = new Set<string>()
    const sessions = []
    const pending = [sessionId]
    while (pending.length) {
      const id = pending.shift()
      if (id === undefined) break
      if (visited.has(id)) continue
      visited.add(id)
      const snapshot = await ctx.sessionQuery.readSession(id)
      const requests = []
      for (const event of snapshot.events) {
        if (event.type === 'data-agent/request') {
          try {
            const request = await readRequest(data, id, event.data.requestId)
            if (request.sha256 !== event.data.sha256)
              throw new Error('Request snapshot digest differs from its log locator.')
            requests.push({ requestId: event.data.requestId, ...request })
          } catch (error) {
            requests.push({ requestId: event.data.requestId, missing: true, error: String(error) })
          }
        }
        if (
          'childId' in event.data &&
          typeof event.data.childId === 'string' &&
          !visited.has(event.data.childId)
        )
          pending.push(SessionId(event.data.childId))
      }
      sessions.push({
        sessionId: id,
        header: snapshot.session,
        events: snapshot.events,
        requests,
        missingRequestLocators: !requests.length,
      })
      if (data.config.maxResultBytes > 0 && Buffer.byteLength(JSON.stringify(sessions)) > data.config.maxResultBytes)
        throw new Error(
          'Trace export exceeds the configured byte limit; inspect individual requests instead.',
        )
    }
    const trajectory = { version: 1, scope: 'harness', sessions }
    const md = `# Execution trace\n\nRoot session: ${sessionId}\n\n${sessions.map(snapshot => `## Session ${snapshot.sessionId}\n\n${snapshot.missingRequestLocators ? 'Actual request snapshots are unavailable for this historical session.\n\n' : ''}${snapshot.events.map(event => `### ${event.seq}: ${event.type}\n\nTime: ${new Date(event.time).toISOString()}\n\n\`\`\`\`json\n${JSON.stringify(event.data, null, 2)}\n\`\`\`\`\n`).join('\n')}\n## Actual requests\n\n\`\`\`\`json\n${JSON.stringify(snapshot.requests, null, 2)}\n\`\`\`\`\n`).join('\n')}`
    return new Response(url.searchParams.get('format') === 'md' ? md : JSON.stringify(trajectory, null, 2), {
      headers: {
        'content-type': 'text/plain; charset=utf-8',
        'content-disposition': `attachment; filename="${url.searchParams.get('format') === 'md' ? 'trace.md' : 'trajectory.json'}"`,
      },
    })
  })
}
