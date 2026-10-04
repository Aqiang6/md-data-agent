/** Versioned Markdown evidence and complete, bounded analysis artifacts. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, extname, join, relative, resolve, sep } from 'node:path'
import { Worker } from 'node:worker_threads'
import { z } from 'zod'
import type { Config } from './config.ts'
import { DocumentId, ResultId } from './brand.ts'
import { isSqliteDatabaseName, listDatabases, resolveDatabasePath } from './databases.ts'
import { SourceCatalog } from './source-catalog.ts'
import type { CredentialLookup } from './source-catalog.ts'
import { decodeSchema } from './source-schema.ts'
import type { DatabaseMetadata } from './source-schema.ts'
import { SourceMarkdownStore } from './source-markdown.ts'
import type { KnowledgeDocument, SourceKnowledge } from './source-markdown.ts'
import { dataScopeSchema } from './data-scope.ts'
import type { DataScope } from './data-scope.ts'

const resultSchema = z.object({
  columns: z.array(z.string()),
  rows: z.array(z.record(z.string(), z.union([z.string(), z.number(), z.boolean(), z.null()]))),
})
/** Complete query output; preview truncation does not change its row count. */
export type DataResult = z.infer<typeof resultSchema>
/** Complete SQL result locator with a bounded preview. */
export interface SqlResult extends DataResult {
  /** Number of rows in the saved file. */
  rowCount: number
  /** Whether the preview omits saved rows. */
  truncated: boolean
  /** Configured source used for execution. */
  database: string
  /** Session-owned result identity. */
  resultId: ResultId
  /** Absolute path readable by file tools. */
  path: string
}
/** Immutable Markdown evidence reference. */
export interface DocumentRef {
  id: DocumentId
  version: string
  title: string
  source: string
  generatedAt: string
  path: string
}
/** Query evidence returned to the UI and model. */
export interface ResultRef extends DataResult {
  resultId: ResultId
  database: string
  rowCount: number
  truncated: boolean
  document: DocumentRef
  parents: ResultId[]
}
/** Search page over current immutable document versions. */
export interface SearchPage {
  documents: DocumentRef[]
  totalMatches: number
  nextOffset: number | null
}
/** Exact-version Markdown character page. */
export interface DocumentPage {
  id: string
  version: string
  offset: number
  markdown: string
  totalChars: number
  nextOffset: number | null
}
/** Source discovery with explicit document-reading failures. */
export interface SourceDiscovery {
  /** Default source restored from successful selection commands. */
  defaultDatabase: string | null
  databases: string[]
  documents: DocumentRef[]
  index: DocumentRef
  unavailable: Array<{ database: string; error: string }>
}
/** Imported worksheet source and reading reference. */
export interface ImportedSource {
  database: string
  metadata: unknown
  document: DocumentRef
}

/** Run one worker and await termination before resolving cancellation or failure.
 * @param input - validated operation fields.
 * @param config - execution limits.
 * @param signal - invocation cancellation.
 * @returns structured worker output.
 */
export async function runWorker(
  input: Record<string, unknown>,
  config: Config,
  signal: AbortSignal,
): Promise<unknown> {
  signal.throwIfAborted()
  const worker = new Worker(new URL('../src/query-worker.mjs', import.meta.url), {
    workerData: { ...input, maxRows: config.maxResultRows, maxBytes: config.maxResultBytes },
  })
  const controller = new AbortController()
  const reason = (): Error =>
    controller.signal.reason instanceof Error
      ? controller.signal.reason
      : new Error('Data operation cancelled.')
  const cancel = (): void => {
    controller.abort(signal.reason)
  }
  signal.addEventListener('abort', cancel, { once: true })
  const timer = config.queryTimeoutMs > 0 ? setTimeout(() => {
    controller.abort(new Error('Data operation timed out.'))
  }, config.queryTimeoutMs) : undefined
  let grace: ReturnType<typeof setTimeout> | undefined
  try {
    return await new Promise<unknown>((accept, reject) => {
      worker.once('message', (raw: unknown) => {
        if (controller.signal.aborted) {
          reject(reason())
          return
        }
        const decoded = z
          .discriminatedUnion('ok', [
            z.object({ ok: z.literal(true), value: z.unknown() }),
            z.object({ ok: z.literal(false), error: z.string() }),
          ])
          .safeParse(raw)
        if (!decoded.success) {
          reject(decoded.error)
          return
        }
        const message = decoded.data
        if (message.ok) accept(message.value)
        else reject(new Error(message.error))
      })
      worker.once('error', reject)
      worker.once('exit', (code) => {
        reject(new Error(`Data worker exited before a result (${code}).`))
      })
      controller.signal.addEventListener(
        'abort',
        () => {
          worker.postMessage({ cancel: true })
          // Native SQLite must acknowledge interrupt before Worker termination can join it.
          grace = setTimeout(() => {
            reject(reason())
          }, config.cancellationGraceMs)
        },
        { once: true },
      )
    })
  } finally {
    clearTimeout(timer)
    clearTimeout(grace)
    signal.removeEventListener('abort', cancel)
    await worker.terminate()
  }
}

/** Session-scoped data operations shared by Web and SDK consumers. */
export class DataCore {
  private readonly documentWrites = new Map<string, Promise<void>>()
  private readonly scopes = new Map<string, DataScope | null>()
  private readonly scopeLoads = new Map<string, Promise<void>>()
  /** Human-managed connection catalog, excluding model credential access. */
  readonly catalog: SourceCatalog
  /** Source-scoped structure Markdown with immutable content versions. */
  readonly schemas: SourceMarkdownStore
  /** Source-scoped, versioned business knowledge, separate from structural metadata. */
  readonly businesses: SourceMarkdownStore
  /** @param config - validated deployment paths and limits.
   * @param credentials - optional credential provider for connection management.
   * @param loadScope - durable session selection reader, including parent selection.
   * @param legacyDefault - picker source restored by the same durable selection reader.
   */
  constructor(
    readonly config: Config,
    credentials?: CredentialLookup,
    private readonly loadScope?: (sessionId: string) => Promise<DataScope | null>,
    private readonly legacyDefault?: (sessionId: string) => string | null,
  ) {
    this.catalog = new SourceCatalog(config, (input, signal) => runWorker(input, config, signal), credentials)
    this.schemas = new SourceMarkdownStore(config, 'source-schemas')
    this.businesses = new SourceMarkdownStore(config, 'source-business')
  }

  /** Publish source-owned schema and business file references for the system prompt.
   * Configured or uploaded content refreshes on each request without connecting to a database.
   * @param sessionId - analysis owner.
   * @param signal - request cancellation before publishing document files.
   * @returns compact source and document directory for the logged system prompt.
   */
  async analysisContext(sessionId: string, signal: AbortSignal = new AbortController().signal): Promise<string> {
    await this.restoreScope(sessionId)
    signal.throwIfAborted()
    const sources = (await this.catalog.list()).filter(source => this.enabledDatabase(sessionId, source.id))
    const files: Array<{ database: string; filename: string; path: string; markdown: string }> = []
    for (const [index, source] of sources.entries()) {
      const schema = (await this.schemas.render(source.id, source.name)).documents.filter(item => item.enabled)
      const business = (await this.businesses.render(source.id, source.name)).documents.filter(item => item.enabled)
      for (const document of schema)
        files.push({ database: source.id, filename: document.filename, markdown: document.markdown,
          path: `source-${index + 1}/schema/${document.filename}` })
      for (const document of business)
        files.push({ database: source.id, filename: document.filename, markdown: document.markdown,
          path: `source-${index + 1}/business/${document.filename}` })
    }
    signal.throwIfAborted()
    const version = createHash('sha256').update(JSON.stringify(files)).digest('hex')
    const directory = join(this.root(sessionId), 'knowledge', version)
    for (const file of files) {
      const path = join(directory, file.path)
      await mkdir(dirname(path), { recursive: true })
      try { await writeFile(path, file.markdown, { flag: 'wx' }) }
      catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      }
    }
    const context = sources.map((source) => {
      const label = `数据库：${source.id}（${source.kind === 'mysql' ? 'MySQL' : 'SQLite'}${source.id === this.defaultDatabase(sessionId) ? '，默认' : ''}）`
      const references = files.filter(file => file.database === source.id)
        .map(file => `- ${file.filename}：${file.path}`).join('\n')
      return `${label}\n${references}`
    }).join('\n\n')
    return `${context || '当前未启用数据库。'}${files.length ? `\n\n资料目录： ${directory.replaceAll('\\', '/')}\n\n上述文件相对于资料目录，read 时拼接为完整路径。` : ''}`
  }

  /** Execute SQL into a complete file while retaining only the preview in memory.
   * @param sessionId - result owner.
   * @param database - configured source.
   * @param sql - read-only statement.
   * @param params - positional parameter values.
   * @param signal - caller cancellation.
   * @param timeoutMs - optional execution deadline; zero disables it.
   * @returns complete file locator, columns, row count and preview.
   */
  async executeSql(sessionId: string, database: string, sql: string,
    params: Array<string | number | boolean | null>, signal: AbortSignal, timeoutMs?: number): Promise<SqlResult> {
    await this.restoreScope(sessionId)
    if (!this.enabledDatabase(sessionId, database)) throw new Error('Database is not enabled for this analysis.')
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 2_147_483_647))
      throw new Error('timeoutMs must be an integer from 0 to 2147483647.')
    const resultId = ResultId(randomUUID())
    const directory = join(this.root(sessionId), 'results')
    await mkdir(directory, { recursive: true })
    const path = join(directory, `${resultId}.json`)
    try {
      const raw = await runWorker({ ...await this.catalog.target(database), database, sql, params,
        outputPath: path, previewRows: this.config.maxRows },
      timeoutMs === undefined ? this.config : Object.assign({}, this.config, { queryTimeoutMs: timeoutMs }), signal)
      const result = resultSchema.extend({ rowCount: z.number().int().nonnegative(), truncated: z.boolean() }).parse(raw)
      return { ...result, database, resultId, path: path.replaceAll('\\', '/') }
    } catch (error) {
      await rm(path, { force: true })
      throw error
    }
  }

  /** Restore the session's successful selection once before using it.
   * @param sessionId - selection owner.
   */
  async restoreScope(sessionId: string): Promise<void> {
    if (this.scopes.has(sessionId)) return
    let pending = this.scopeLoads.get(sessionId)
    if (!pending) {
      pending = (async () => {
        const scope = this.loadScope ? await this.loadScope(sessionId) : null
        if (!this.scopes.has(sessionId)) this.scopes.set(sessionId, scope)
      })()
      this.scopeLoads.set(sessionId, pending)
    }
    try {
      await pending
    } finally {
      if (this.scopeLoads.get(sessionId) === pending) this.scopeLoads.delete(sessionId)
    }
  }

  /** Return a restored selection for logged runtime context.
   * @param sessionId - selection owner.
   * @returns explicit enabled databases, or legacy discovery mode.
   */
  scope(sessionId: string): DataScope | null {
    return this.scopes.get(sessionId) ?? null
  }

  /** Read the restored default source without changing an explicit cleared default.
   * @param sessionId - selection owner; restoreScope must have completed.
   * @returns selected source, or null without a default.
   */
  defaultDatabase(sessionId: string): string | null {
    const scope = this.scope(sessionId)
    return scope ? scope.defaultDatabase : this.legacyDefault?.(sessionId) ?? null
  }

  private enabledDatabase(sessionId: string, database: string): boolean {
    if (database.startsWith('import:')) return true
    const scope = this.scope(sessionId)
    if (scope) return scope.sources.some(source => source.database === database)
    const selected = this.defaultDatabase(sessionId)
    return selected === null || selected === database
  }

  /** Invalidate restored source selection after a command settles; the log remains authoritative.
   * @param sessionId - selection owner.
   */
  forgetScope(sessionId: string): void {
    this.scopes.delete(sessionId)
  }

  /** Validate a human database selection against the configured catalog without applying it.
   * @param sessionId - selection owner.
   * @param raw - untrusted form or command JSON.
   * @param signal - caller cancellation.
   * @returns normalized selection for the command log.
   */
  async validateScope(sessionId: string, raw: unknown, signal: AbortSignal): Promise<DataScope> {
    this.root(sessionId)
    signal.throwIfAborted()
    const scope = dataScopeSchema.parse(raw)
    if (new Set(scope.sources.map(source => source.database)).size !== scope.sources.length)
      throw new Error('Select each database only once.')
    if (
      scope.defaultDatabase !== null &&
      !scope.sources.some(source => source.database === scope.defaultDatabase)
    )
      throw new Error('Default database must be enabled.')
    const available = new Set((await this.catalog.list()).map(source => source.id))
    if (scope.sources.some(source => !available.has(source.database)))
      throw new Error('Selection contains an unknown database.')
    signal.throwIfAborted()
    return scope
  }

  /** Apply a validated selection for direct data-core consumers without command logging.
   * @param sessionId - selection owner.
   * @param raw - untrusted selection.
   * @param signal - caller cancellation.
   * @returns applied scope.
   */
  async setScope(sessionId: string, raw: unknown, signal: AbortSignal): Promise<DataScope> {
    const scope = await this.validateScope(sessionId, raw, signal)
    this.scopes.set(sessionId, scope)
    return scope
  }

  /** Resolve a session store, refusing identifiers that could escape it.
   * @param sessionId - session-owned identifier.
   * @returns absolute evidence directory.
   */
  root(sessionId: string): string {
    if (!/^[a-zA-Z0-9_-]+$/u.test(sessionId)) throw new Error('Invalid session identifier.')
    return resolve(this.config.artifactsDirectory, sessionId)
  }

  /** Create an immutable content-addressed document.
   * @param sessionId - evidence owner.
   * @param title - human-readable title.
   * @param source - metadata origin, without credentials.
   * @param body - Markdown content.
   * @returns versioned document reference.
   */
  async document(sessionId: string, title: string, source: string, body: string): Promise<DocumentRef> {
    const previous = this.documentWrites.get(sessionId) ?? Promise.resolve()
    const write = previous.then(() => this.writeDocument(sessionId, title, source, body))
    const settled = write.then(
      () => undefined,
      () => undefined,
    )
    this.documentWrites.set(sessionId, settled)
    try {
      return await write
    } finally {
      if (this.documentWrites.get(sessionId) === settled) this.documentWrites.delete(sessionId)
    }
  }

  private async writeDocument(
    sessionId: string,
    title: string,
    source: string,
    body: string,
  ): Promise<DocumentRef> {
    const id = DocumentId(createHash('sha256').update(source).digest('hex').slice(0, 20))
    const version = createHash('sha256').update(body).digest('hex')
    const directory = join(this.root(sessionId), 'documents')
    await mkdir(directory, { recursive: true })
    const path = join(directory, `${id}-${version}.md`)
    let ref = { id, version, title, source, generatedAt: new Date().toISOString(), path }
    try {
      await writeFile(
        path,
        `# ${title}\n\nSource: ${source}\n\nVersion: ${version}\n\nGenerated: ${ref.generatedAt}\n\n${body}\n`,
        { flag: 'wx' },
      )
      await writeFile(`${path}.json`, JSON.stringify(ref), { flag: 'wx' })
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      ref = z
        .object({
          id: z.string().transform(DocumentId),
          version: z.string(),
          title: z.string(),
          source: z.string(),
          generatedAt: z.string(),
          path: z.string(),
        })
        .parse(JSON.parse(await readFile(`${path}.json`, 'utf8')))
    }
    const pointer = join(directory, `${id}.current.json`)
    const temporary = `${pointer}.${randomUUID()}.tmp`
    await writeFile(temporary, JSON.stringify(ref), { flag: 'wx' })
    await rename(temporary, pointer)
    return ref
  }

  /** List business and metadata documents using a bounded query.
   * @param sessionId - evidence owner.
   * @param query - case-insensitive text match.
   * @param offset - match cursor, initially zero.
   * @returns current document versions and explicit pagination.
   */
  async search(sessionId: string, query: string, offset: number = 0): Promise<SearchPage> {
    await this.restoreScope(sessionId)
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid search cursor.')
    const business = resolve(this.config.documentsDirectory)
    await mkdir(business, { recursive: true })
    const manifest = await this.businesses.manifest()
    const mapped = new Set(manifest.sources.flatMap(source => source.documents.map(document => document.filename)))
    const visibleKnowledge = new Set<string>()
    for (const entry of await readdir(business)) {
      if (entry.endsWith('.md') && !mapped.has(entry))
        await this.document(
          sessionId,
          basename(entry, '.md'),
          `business:${entry}`,
          await readFile(join(business, entry), 'utf8'),
        )
    }
    for (const source of await this.catalog.list()) {
      if (!this.enabledDatabase(sessionId, source.id)) continue
      const knowledge = await this.business(sessionId, source.id)
      const entries = [
        ...await this.publishKnowledge(sessionId, source.id, 'business', knowledge.documents),
        ...await this.publishKnowledge(sessionId, source.id, 'schema', (await this.schemas.render(source.id, source.name)).documents),
      ]
      for (const entry of entries) visibleKnowledge.add(entry.source)
      await this.document(
        sessionId,
        `${source.name} business.md`,
        `business-source:${source.id}`,
        knowledge.markdown,
      )
    }
    const directory = join(this.root(sessionId), 'documents')
    await mkdir(directory, { recursive: true })
    const current = new Map<string, DocumentRef>()
    const files = await readdir(directory)
    const pointers = files.filter(name => name.endsWith('.current.json'))
    for (const file of (pointers.length
      ? pointers
      : files.filter(name => name.endsWith('.md.json'))
    ).sort()) {
      const ref = z
        .object({
          id: z.string().transform(DocumentId),
          version: z.string(),
          title: z.string(),
          source: z.string(),
          generatedAt: z.string(),
          path: z.string(),
        })
        .parse(JSON.parse(await readFile(join(directory, file), 'utf8')))
      const previous = current.get(ref.id)
      if (!previous || ref.generatedAt >= previous.generatedAt) current.set(ref.id, ref)
    }
    const found: DocumentRef[] = []
    for (const ref of [...current.values()].sort((a, b) => a.title.localeCompare(b.title))) {
      if (ref.source.startsWith('source-knowledge:') && !visibleKnowledge.has(ref.source)) continue
      if (ref.source.startsWith('business-source:')) continue
      if (ref.source.startsWith('schema:') && !this.enabledDatabase(sessionId, ref.source.slice('schema:'.length))) continue
      if (ref.source.startsWith('business:') && mapped.has(ref.source.slice('business:'.length))) continue
      const content = await readFile(join(directory, `${ref.id}-${ref.version}.md`), 'utf8')
      if (`${ref.title}\n${content}`.toLowerCase().includes(query.toLowerCase())) found.push(ref)
    }
    const end = Math.min(found.length, offset + 50)
    return {
      documents: found.slice(offset, end),
      totalMatches: found.length,
      nextOffset: end < found.length ? end : null,
    }
  }

  private async publishKnowledge(
    sessionId: string,
    database: string,
    category: 'schema' | 'business',
    documents: KnowledgeDocument[],
  ): Promise<DocumentRef[]> {
    const references: DocumentRef[] = []
    for (const item of documents.filter(document => document.enabled))
      references.push(await this.document(
        sessionId, `${database} ${item.filename}`,
        `source-knowledge:${database}:${category}:${item.id}`,
        `Filename: ${item.filename}\n\nOrigin: ${item.origin}\n\nContent version: ${item.version}\n\nReference only; does not change query permissions or actual database fields.\n\n${item.markdown}`,
      ))
    return references
  }

  /** Read an exact document version with explicit character pagination.
   * @param sessionId - evidence owner.
   * @param id - content source identifier.
   * @param version - immutable content version.
   * @param offset - character cursor.
   * @returns Markdown page and continuation cursor.
   */
  async read(sessionId: string, id: string, version: string, offset: number): Promise<DocumentPage> {
    if (
      !/^[a-f0-9]{20}$/u.test(id) ||
      !/^[a-f0-9]{64}$/u.test(version) ||
      !Number.isInteger(offset) ||
      offset < 0
    )
      throw new Error('Invalid document reference or cursor.')
    const content = await readFile(join(this.root(sessionId), 'documents', `${id}-${version}.md`), 'utf8')
    const end = Math.min(content.length, offset + this.config.documentPageChars)
    return {
      id,
      version,
      offset,
      markdown: content.slice(offset, end),
      totalChars: content.length,
      nextOffset: end < content.length ? end : null,
    }
  }

  /** Discover sources and publish their configured or uploaded Markdown references.
   * @param sessionId - evidence owner.
   * @param signal - invocation cancellation.
   * @returns source names and index document.
   */
  async sources(sessionId: string, signal: AbortSignal): Promise<SourceDiscovery> {
    await this.restoreScope(sessionId)
    const databases = (await this.catalog.list()).map(source => source.id)
    const imports = join(this.root(sessionId), 'imports')
    await mkdir(imports, { recursive: true })
    databases.push(...(await readdir(imports)).filter(isSqliteDatabaseName).map(name => `import:${name}`))
    const enabled = databases.filter(database => this.enabledDatabase(sessionId, database))
    const documents: DocumentRef[] = []
    const unavailable: Array<{ database: string; error: string }> = []
    for (const database of enabled) {
      let schema: SourceKnowledge
      try {
        schema = await this.schema(sessionId, database, signal)
      } catch (error) {
        signal.throwIfAborted()
        const message = error instanceof Error ? error.message : String(error)
        unavailable.push({ database, error: message })
        documents.push(
          await this.document(
            sessionId,
            `${database} unavailable`,
            `schema:${database}`,
            `## unavailable\n\nStructure documents could not be read: ${message}`,
          ),
        )
        continue
      }
      documents.push(...await this.publishKnowledge(sessionId, database, 'schema', schema.documents))
      if (!database.startsWith('import:')) {
        const knowledge = await this.business(sessionId, database)
        documents.push(...await this.publishKnowledge(sessionId, database, 'business', knowledge.documents))
        documents.push(
          await this.document(
            sessionId,
            `${database} business.md`,
            `business-source:${database}`,
            knowledge.markdown,
          ),
        )
      }
    }
    const index = await this.document(
      sessionId,
      'Data source index',
      'sources',
      documents.map(ref => `- ${ref.title}: document ${ref.id}, version ${ref.version}`).join('\n'),
    )
    return { databases: enabled, defaultDatabase: this.defaultDatabase(sessionId), documents, index, unavailable }
  }

  /** Read separate business knowledge for a known source.
   * @param sessionId - enabled-scope owner.
   * @param database - public catalog source key.
   * @param filtered - require the database to be enabled for model discovery.
   * @returns source-linked Markdown and its upload versions.
   */
  async business(sessionId: string, database: string, filtered: boolean = true): Promise<SourceKnowledge> {
    this.root(sessionId)
    if (filtered) await this.restoreScope(sessionId)
    const source = (await this.catalog.list()).find(item => item.id === database)
    if (!source) throw new Error('Unknown database for business knowledge.')
    if (filtered && !this.enabledDatabase(sessionId, database))
      throw new Error('Database is not enabled for this analysis.')
    return this.businesses.render(database, source.name)
  }

  /** Read this database's configured and uploaded structure Markdown without a database connection.
   * @param sessionId - document owner and source selection.
   * @param database - catalog or imported source key.
   * @param signal - caller cancellation.
   * @param filtered - require the database to be enabled for analysis.
   * @returns source-linked structure documents, including disabled entries for management.
   */
  async schema(sessionId: string, database: string, signal: AbortSignal, filtered: boolean = true): Promise<SourceKnowledge> {
    this.root(sessionId)
    if (filtered) await this.restoreScope(sessionId)
    signal.throwIfAborted()
    const name = database.startsWith('import:') ? database
      : (await this.catalog.list()).find(source => source.id === database)?.name
    if (!name) throw new Error('Unknown database for structure knowledge.')
    if (filtered && !this.enabledDatabase(sessionId, database))
      throw new Error('Database is not enabled for this analysis.')
    return this.schemas.render(database, name)
  }

  /** Discover actual table fields for the human browser without generating documents.
   * @param sessionId - evidence owner for imported sources and scope.
   * @param database - catalog or imported source key.
   * @param signal - caller cancellation.
   * @param filtered - whether to require a session-enabled database.
   * @returns actual table and column metadata.
   */
  async metadata(
    sessionId: string,
    database: string,
    signal: AbortSignal,
    filtered: boolean = true,
  ): Promise<DatabaseMetadata> {
    if (filtered) await this.restoreScope(sessionId)
    const target = database.startsWith('import:')
      ? { action: 'sqlite' as const, path: this.sourcePath(sessionId, database) }
      : await this.catalog.target(database)
    const sqlite = target.action === 'sqlite'
    const raw = await runWorker(
      sqlite
        ? { action: 'schema', path: target.path }
        : {
          ...target,
          sql: 'SELECT c.TABLE_NAME,c.COLUMN_NAME,c.COLUMN_TYPE,c.IS_NULLABLE,c.COLUMN_KEY,c.COLUMN_COMMENT,k.REFERENCED_TABLE_NAME,k.REFERENCED_COLUMN_NAME FROM information_schema.COLUMNS c LEFT JOIN information_schema.KEY_COLUMN_USAGE k ON k.TABLE_SCHEMA=c.TABLE_SCHEMA AND k.TABLE_NAME=c.TABLE_NAME AND k.COLUMN_NAME=c.COLUMN_NAME AND k.REFERENCED_TABLE_NAME IS NOT NULL WHERE c.TABLE_SCHEMA=? ORDER BY c.TABLE_NAME,c.ORDINAL_POSITION',
          params: [target.database],
        },
      this.config,
      signal,
    )
    if (filtered && !this.enabledDatabase(sessionId, database))
      throw new Error('Database is not enabled for this analysis.')
    const tables = decodeSchema(raw, sqlite)
    return { database, tables }
  }

  private sourcePath(sessionId: string, database: string): string {
    if (database.startsWith('import:')) {
      const name = database.slice(7)
      if (basename(name) !== name || !isSqliteDatabaseName(name)) throw new Error('Invalid imported source.')
      return join(this.root(sessionId), 'imports', name)
    }
    if (!listDatabases(this.config).includes(database)) throw new Error('Unknown configured data source.')
    return resolveDatabasePath(this.config.directory, database)
  }

  /** Execute and save every row before returning a bounded preview.
   * @param sessionId - evidence owner.
   * @param database - discovered source.
   * @param sql - read-only statement.
   * @param params - positional SQL values.
   * @param signal - invocation cancellation.
   * @returns complete-result reference and preview.
   */
  async query(
    sessionId: string,
    database: string,
    sql: string,
    params: Array<string | number | boolean | null>,
    signal: AbortSignal,
  ): Promise<ResultRef> {
    await this.restoreScope(sessionId)
    if (!this.enabledDatabase(sessionId, database))
      throw new Error('Database is not enabled for this analysis.')
    const input = database.startsWith('import:')
      ? { action: 'sqlite', path: this.sourcePath(sessionId, database) }
      : await this.catalog.target(database)
    const result = resultSchema.parse(
      await runWorker(
        { ...input, sql, params },
        this.config,
        signal,
      ),
    )
    return this.save(
      sessionId,
      database,
      result,
      `SQL:\n\n\`\`\`sql\n${sql}\n\`\`\`\n\nParameters: ${JSON.stringify(params)}`,
      [],
    )
  }

  private async save(
    sessionId: string,
    database: string,
    result: DataResult,
    method: string,
    parents: string[],
  ): Promise<ResultRef> {
    const resultId = ResultId(randomUUID())
    const directory = join(this.root(sessionId), 'results')
    await mkdir(directory, { recursive: true })
    await writeFile(join(directory, `${resultId}.json`), JSON.stringify(result), { flag: 'wx' })
    const document = await this.document(
      sessionId,
      `Result ${resultId}`,
      `result:${resultId}`,
      `## method\n\n${method}\n\nParents: ${parents.join(', ') || '(none)'}\n\n## summary\n\nComplete rows: ${result.rows.length}\n\nColumns: ${result.columns.join(', ')}\n\n## preview\n\n\`\`\`json\n${JSON.stringify(result.rows.slice(0, this.config.maxRows), null, 2)}\n\`\`\`\n\nPreview only; complete data is retained for computation.`,
    )
    return {
      ...result,
      rows: result.rows.slice(0, this.config.maxRows),
      resultId,
      database,
      rowCount: result.rows.length,
      truncated: result.rows.length > this.config.maxRows,
      document,
      parents: parents.map(ResultId),
    }
  }

  /** Resolve a complete result owned by this session.
   * @param sessionId - evidence owner.
   * @param resultId - result identifier.
   * @returns validated full data.
   */
  async result(sessionId: string, resultId: string): Promise<DataResult> {
    return resultSchema.parse(JSON.parse(await readFile(this.resultPath(sessionId, resultId), 'utf8')))
  }

  private resultPath(sessionId: string, resultId: string): string {
    if (!/^[a-f0-9-]{36}$/u.test(resultId)) throw new Error('Invalid result identifier.')
    return join(this.root(sessionId), 'results', `${resultId}.json`)
  }

  /** Import local CSV/XLSX/Parquet values into a session-owned SQLite source.
   * @param sessionId - new source owner.
   * @param path - file inside the session workspace.
   * @param workspace - session working directory.
   * @param signal - invocation cancellation.
   * @returns imported source and worksheet metadata.
   */
  async import(
    sessionId: string,
    path: string,
    workspace: string,
    signal: AbortSignal,
  ): Promise<ImportedSource> {
    const file = await realpath(resolve(workspace, path))
    const base = await realpath(workspace)
    const rel = relative(base, file)
    if (rel.startsWith(`..${sep}`) || rel === '..' || resolve(file) === base)
      throw new Error('Import must be inside the session workspace.')
    if ((await stat(file)).size > this.config.maxResultBytes)
      throw new Error('Import file exceeds byte limit.')
    const extension = extname(file).toLowerCase()
    if (!['.csv', '.xlsx', '.parquet'].includes(extension))
      throw new Error('Supported formats: CSV, XLSX, Parquet.')
    const directory = join(this.root(sessionId), 'imports')
    await mkdir(directory, { recursive: true })
    const name = `${randomUUID()}.sqlite`
    let value: unknown
    try {
      value = await runWorker(
        { action: 'import', path: file, extension, destination: join(directory, name) },
        this.config,
        signal,
      )
    } catch (error) {
      await rm(join(directory, name), { force: true })
      throw error
    }
    return {
      database: `import:${name}`,
      metadata: value,
      document: await this.document(
        sessionId,
        'Imported dataset',
        `import:${name}`,
        `## worksheets\n\nOriginal file: ${basename(file)}\n\n\`\`\`json\n${JSON.stringify(value, null, 2)}\n\`\`\``,
      ),
    }
  }

  /** Execute a compiled, controlled analysis operation over complete data.
   * @param sessionId - evidence owner.
   * @param resultId - left input.
   * @param operation - validated operator and column selections.
   * @param signal - invocation cancellation.
   * @returns new evidence with parent identifiers.
   */
  async analyze(
    sessionId: string,
    resultId: string,
    operation: unknown,
    signal: AbortSignal,
  ): Promise<ResultRef> {
    const spec = z
      .discriminatedUnion('kind', [
        z.object({
          kind: z.literal('group'),
          by: z.array(z.string()),
          column: z.string(),
          aggregate: z.enum(['sum', 'avg', 'min', 'max', 'count']),
        }),
        z.object({ kind: z.literal('sort'), column: z.string(), descending: z.boolean().default(false) }),
        z.object({ kind: z.literal('drop_nulls'), columns: z.array(z.string()).min(1) }),
        z.object({ kind: z.literal('distinct') }),
        z.object({ kind: z.literal('period_compare'), period: z.string(), column: z.string() }),
        z.object({
          kind: z.literal('join'),
          rightResultId: z.string(),
          leftColumn: z.string(),
          rightColumn: z.string(),
        }),
      ])
      .parse(operation)
    const data = await this.result(sessionId, resultId)
    const column = (name: string): string => {
      if (!data.columns.includes(name)) throw new Error(`Unknown column: ${name}`)
      return `"${name.replaceAll('"', '""')}"`
    }
    let sql: string
    let rightPath: string | undefined
    const parents = [resultId]
    switch (spec.kind) {
      case 'group':
        sql = `SELECT ${spec.by.length ? spec.by.map(column).join(',') + ',' : ''}${spec.aggregate}(${column(spec.column)}) AS value FROM data${spec.by.length ? ' GROUP BY ' + spec.by.map(column).join(',') : ''}`
        break
      case 'sort':
        sql = `SELECT * FROM data ORDER BY ${column(spec.column)} ${spec.descending ? 'DESC' : 'ASC'}`
        break
      case 'drop_nulls':
        sql = `SELECT * FROM data WHERE ${spec.columns.map(name => `${column(name)} IS NOT NULL`).join(' AND ')}`
        break
      case 'distinct':
        sql = 'SELECT DISTINCT * FROM data'
        break
      case 'period_compare': {
        const value = column(spec.column)
        const period = column(spec.period)
        const periods = data.rows.map(row => row[spec.period])
        if (new Set(periods).size !== periods.length || periods.some(item => item === null))
          throw new Error('Period comparison requires one non-null row per period; aggregate first.')
        if (data.rows.some(row => typeof row[spec.column] !== 'number'))
          throw new Error('Period comparison requires numeric values.')
        sql = `WITH p AS (SELECT ${period} AS period,${value} AS value,LAG(${value}) OVER (ORDER BY ${period}) AS previous_value FROM data) SELECT *,CASE WHEN previous_value IS NOT NULL AND previous_value != 0 THEN (CAST(value AS REAL)-CAST(previous_value AS REAL))/ABS(CAST(previous_value AS REAL))*100 END AS change_percent FROM p ORDER BY period`
        break
      }
      case 'join': {
        const right = await this.result(sessionId, spec.rightResultId)
        if (!right.columns.includes(spec.rightColumn)) throw new Error('Unknown right join column.')
        rightPath = this.resultPath(sessionId, spec.rightResultId)
        parents.push(spec.rightResultId)
        const q = (name: string): string => `"${name.replaceAll('"', '""')}"`
        sql = `SELECT data.*,${right.columns.map(name => `right_data.${q(name)} AS ${q(`right_${name}`)}`).join(',')} FROM data JOIN right_data ON data.${column(spec.leftColumn)}=right_data.${q(spec.rightColumn)}`
        break
      }
    }
    const scratchDirectory = join(this.root(sessionId), 'scratch')
    await mkdir(scratchDirectory, { recursive: true })
    const scratchPath = join(scratchDirectory, `${randomUUID()}.sqlite`)
    try {
      const result = resultSchema.parse(
        await runWorker(
          {
            action: 'analysis',
            resultPath: this.resultPath(sessionId, resultId),
            rightPath,
            sql,
            scratchPath,
          },
          this.config,
          signal,
        ),
      )
      return await this.save(sessionId, 'analysis', result, JSON.stringify(spec), parents)
    } finally {
      await rm(scratchPath, { force: true })
    }
  }
}
