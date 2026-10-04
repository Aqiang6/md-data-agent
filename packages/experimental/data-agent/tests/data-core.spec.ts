/** Real worker, evidence, import, and report operations with test-owned databases. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { DataCore } from '../src/data-core.ts'
import { Config } from '../src/config.ts'
import { artifact, report, readArtifact, chart } from '../src/reports.ts'

let root: string
let data: DataCore
const signal = (): AbortSignal => new AbortController().signal
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-data-core-'))
  const directory = join(root, 'db')
  await mkdir(directory)
  const db = new DatabaseSync(join(directory, 'shop.db'))
  db.exec(
    "CREATE TABLE orders(id INTEGER PRIMARY KEY, amount REAL, region TEXT); INSERT INTO orders VALUES (1,10,'east'),(2,20,'east'),(3,30,'west');",
  )
  db.close()
  data = new DataCore(
    new Config(Object.assign(Config(), {
      directory,
      artifactsDirectory: join(root, 'evidence'),
      documentsDirectory: join(root, 'docs'),
      maxRows: 1,
      mysqlDatabases: [],
      mysqlUrlEnv: 'MYSQL_URL',
      uiDist: '',
      maxResultRows: 100000,
      maxResultBytes: 50000000,
      queryTimeoutMs: 30000,
      cancellationGraceMs: 5000,
      documentPageChars: 12000,
      maxChartPoints: 100,
      browserExecutablePath: '',
    })),
  )
  await data.schemas.upload('shop.db', 'schema.md', '# Manual schema\n\norders(id INTEGER, amount REAL, region TEXT)')
})
afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

it('lists selected schema and business files without exposing the shared directory', async () => {
  const directory = data.config.documentsDirectory
  await mkdir(directory)
  await writeFile(join(directory, 'source-business.md'), 'Source definitions.')
  await writeFile(join(directory, 'analysis-business.md'), 'Analysis definitions.')
  await writeFile(join(directory, 'sources.json'), JSON.stringify({ version: 1,
    sources: [{ database: 'shop.db', documents: ['source-business.md', 'analysis-business.md'] }] }))
  await writeFile(join(directory, 'report-template.md'), 'Optional template.')
  await writeFile(join(directory, 'shop-metrics.md'), 'Optional metrics.')
  await mkdir(join(directory, 'analysis-skill.md'))
  const other = new DatabaseSync(join(root, 'db', 'other.db'))
  other.exec('CREATE TABLE unrelated(id INTEGER)')
  other.close()
  const scoped = new DataCore(data.config, undefined, async () => null, () => 'shop.db')
  const context = await scoped.analysisContext('context-test', signal())
  expect(context).toContain('数据库：shop.db（SQLite，默认）')
  expect(context.split('\n').filter(line => line.startsWith('- '))).toEqual([
    '- schema.md：source-1/schema/schema.md', '- source-business.md：source-1/business/source-business.md',
    '- analysis-business.md：source-1/business/analysis-business.md',
  ])
  for (const text of ['other.db', 'analysis-skill.md', 'report-template.md', 'shop-metrics.md',
    '分析表参考', '默认库：', '"version"', '工作结果目录']) expect(context).not.toContain(text)
  const path = /资料目录：([^\n]+)/.exec(context)![1]!.trim()
  expect(await readFile(join(path, 'source-1/schema/schema.md'), 'utf8')).toContain('orders')
  expect(await readFile(join(path, 'source-1/business/source-business.md'), 'utf8')).toBe('Source definitions.')
  expect(context).not.toContain('其他资料目录')
  expect(context).not.toContain(directory.replaceAll('\\', '/'))
})

it('preserves immutable context files and refreshes manual documents without metadata queries', async () => {
  const discover = vi.spyOn(data, 'metadata').mockRejectedValue(new Error('Database unavailable.'))
  const first = await data.analysisContext('context-test', signal())
  const original = /资料目录：([^\n]+)/.exec(first)![1]!.trim()
  expect(await data.analysisContext('context-test', signal())).toBe(first)
  await data.businesses.uploadKnowledge('shop.db', 'shop.db', 'business.md', 'Revenue before refunds.')
  await data.schemas.uploadKnowledge('shop.db', 'shop.db', 'manual-schema.md', 'Human structural notes.')
  const revised = await data.analysisContext('context-test', signal())
  const path = /资料目录：([^\n]+)/.exec(revised)![1]!.trim()
  expect(path).not.toBe(original)
  expect(await readFile(join(original, 'source-1/schema/schema.md'), 'utf8')).toContain('orders')
  expect(await readFile(join(path, 'source-1/schema/manual-schema.md'), 'utf8')).toBe('Human structural notes.')
  expect(await readFile(join(path, 'source-1/business/business.md'), 'utf8')).toBe('Revenue before refunds.')
  expect(discover).not.toHaveBeenCalled()
})

it('does not invent missing structure documents and honors request cancellation', async () => {
  const document = (await data.schemas.collection('shop.db')).documents[0]!
  await data.schemas.changeKnowledge('shop.db', 'shop.db', document, { remove: true })
  const first = await data.analysisContext('context-test', signal())
  expect(first).toContain('数据库：shop.db')
  expect(first).not.toContain('schema.md')
  expect(first).not.toContain('资料目录')
  const controller = new AbortController()
  controller.abort(new Error('Analysis cancelled.'))
  await expect(data.analysisContext('context-test', controller.signal)).rejects.toThrow('Analysis cancelled')
})

it('provides a configured MySQL source document without resolving connection credentials', async () => {
  const offline = new DataCore(Object.assign({}, data.config, { mysqlDatabases: ['offline-db'] }),
    undefined, async () => null, () => 'offline-db')
  const connect = vi.spyOn(offline.catalog, 'target').mockRejectedValue(new Error('Connection unavailable.'))
  await offline.schemas.uploadKnowledge('offline-db', 'offline-db', 'fields.md', '# Supplied fields\n\norders(amount DECIMAL)')
  expect(await offline.analysisContext('offline-test', signal())).toContain('- fields.md：source-1/schema/fields.md')
  expect(connect).not.toHaveBeenCalled()
})

it('allows new tables without changing the supplied schema document', async () => {
  const scoped = new DataCore(data.config, undefined, async () => ({
    version: 2, sources: [{ database: 'shop.db' }], defaultDatabase: 'shop.db',
  }))
  const first = await scoped.analysisContext('context-test', signal())
  const db = new DatabaseSync(join(root, 'db', 'shop.db'))
  db.exec('CREATE TABLE newly_added(id INTEGER)')
  db.close()
  expect((await scoped.executeSql('context-test', 'shop.db', 'SELECT COUNT(*) AS total FROM newly_added', [], signal())).rows)
    .toEqual([{ total: 0 }])
  expect(await scoped.analysisContext('context-test', signal())).toBe(first)
  expect((await scoped.metadata('context-test', 'shop.db', signal())).tables.map(table => table.name))
    .toEqual(['newly_added', 'orders'])
})

it('streams all SQL rows to a file with independent preview and optional limits', async () => {
  const unlimited = new DataCore(Object.assign({}, data.config, { maxResultRows: 0, maxResultBytes: 0, queryTimeoutMs: 0 }))
  const sql = 'SELECT id,amount FROM orders WHERE id > ? ORDER BY id; -- complete result'
  const result = await unlimited.executeSql('stream-test', 'shop.db', sql, [0], signal())
  expect(result).toMatchObject({ columns: ['id', 'amount'], rows: [{ id: 1, amount: 10 }], rowCount: 3, truncated: true })
  expect(JSON.parse(await readFile(result.path, 'utf8'))).toEqual({
    database: 'shop.db', sql, params: [0], columns: ['id', 'amount'],
    rows: [{ id: 1, amount: 10 }, { id: 2, amount: 20 }, { id: 3, amount: 30 }],
  })
  expect(result).not.toHaveProperty('document')
  expect(result).not.toHaveProperty('parents')
})

it('accepts metadata, window queries, duplicate columns and exact large integers', async () => {
  expect((await data.executeSql('stream-test', 'shop.db', 'PRAGMA table_info(orders)', [], signal())).rowCount).toBe(3)
  expect((await data.executeSql('stream-test', 'shop.db', 'EXPLAIN QUERY PLAN SELECT * FROM orders', [], signal())).rowCount).toBeGreaterThan(0)
  expect((await data.executeSql('stream-test', 'shop.db', 'SELECT id, ROW_NUMBER() OVER (ORDER BY id) AS n FROM orders', [], signal())).rowCount).toBe(3)
  expect((await data.executeSql('stream-test', 'shop.db', '/* precision */ SELECT 9007199254740993 AS n, 1e20 AS real_number -- comment', [], signal())).rows)
    .toEqual([{ n: '9007199254740993', real_number: 1e20 }])
  const repeated = await data.executeSql('stream-test', 'shop.db', 'SELECT id,id FROM orders', [], signal())
  expect(repeated.columns).toHaveLength(2)
  expect(Object.values(repeated.rows[0]!)).toEqual([1, 1])
})

it('rejects SQL changes without modifying the original database', async () => {
  const path = join(root, 'db', 'shop.db')
  const original = await readFile(path)
  for (const sql of ['UPDATE orders SET amount=0', 'CREATE TABLE x(id)', 'DROP TABLE orders', 'PRAGMA user_version=7', 'WITH x AS (SELECT 1) DELETE FROM orders', 'SELECT * FROM orders; DELETE FROM orders'])
    await expect(data.executeSql('stream-test', 'shop.db', sql, [], signal())).rejects.toThrow()
  expect(await readFile(path)).toEqual(original)
})

it('retains every row while the model receives a bounded preview', async () => {
  const result = await data.query('session-test', 'shop.db', 'SELECT * FROM orders ORDER BY id', [], signal())
  expect(result).toMatchObject({
    rowCount: 3,
    truncated: true,
    rows: [{ id: 1, amount: 10, region: 'east' }],
  })
  expect((await data.result('session-test', result.resultId)).rows).toHaveLength(3)
  const aggregate = await data.analyze(
    'session-test',
    result.resultId,
    { kind: 'group', by: ['region'], column: 'amount', aggregate: 'sum' },
    signal(),
  )
  expect(aggregate.rowCount).toBe(2)
  expect((await data.result('session-test', aggregate.resultId)).rows).toEqual([
    { region: 'east', value: 30 },
    { region: 'west', value: 30 },
  ])
})

it('keeps picker discovery and execution on the restored source while human metadata remains accessible', async () => {
  const other = new DatabaseSync(join(root, 'db', 'other.db'))
  other.exec('CREATE TABLE unrelated(id INTEGER)')
  other.close()
  let selected: string | null = 'shop.db'
  const scoped = new DataCore(data.config, undefined, async () => null, () => selected)
  const discovery = await scoped.sources('picker-test', signal())
  expect(discovery).toMatchObject({ databases: ['shop.db'], defaultDatabase: 'shop.db' })
  expect(discovery.documents.every(item => !item.source.includes('other.db'))).toBe(true)
  await expect(scoped.query('picker-test', 'other.db', 'SELECT COUNT(*) FROM unrelated', [], signal())).rejects.toThrow('not enabled')
  await expect(scoped.schema('picker-test', 'other.db', signal())).rejects.toThrow('not enabled')
  expect((await scoped.metadata('picker-test', 'other.db', signal(), false)).tables[0]?.name).toBe('unrelated')
  selected = null
  scoped.forgetScope('picker-test')
  expect((await scoped.sources('picker-test', signal())).databases).toEqual(['other.db', 'shop.db'])
})
it('preserves columns when a SELECT produces no rows', async () => {
  const result = await data.query(
    'session-test',
    'shop.db',
    'SELECT id AS order_id,amount FROM orders WHERE id < ?',
    [0],
    signal(),
  )
  expect(result).toMatchObject({ columns: ['order_id', 'amount'], rowCount: 0, truncated: false, rows: [] })
})
it('binds boolean SQLite parameters without dropping values', async () => {
  const result = await data.query('session-test', 'shop.db', 'SELECT ? AS enabled', [true], signal())
  expect(result.rows).toEqual([{ enabled: 1 }])
})
it('refuses artifact path escapes and reserved manifest names', async () => {
  for (const filename of ['../escape', 'a/b.md', 'a\\b.md', 'manifest.json']) {
    await expect(artifact(data, 'session-test', filename, 'content')).rejects.toThrow('safe basename')
  }
})
it('rejects unowned artifacts, filename substitutions and changed report bytes', async () => {
  const ref = await artifact(data, 'session-test', 'report.md', 'Verified report')
  await expect(readArtifact(data, 'another-session', ref.artifactId, ref.filename)).rejects.toThrow()
  await expect(readArtifact(data, 'session-test', ref.artifactId, 'report.html')).rejects.toThrow('manifest')
  await writeFile(
    join(data.root('session-test'), 'artifacts', ref.artifactId, ref.filename),
    'Changed report',
  )
  await expect(readArtifact(data, 'session-test', ref.artifactId, ref.filename)).rejects.toThrow(
    'recorded version',
  )
})
it('parses semicolons in literals and refuses multiple or modifying statements', async () => {
  expect((await data.query('session-test', 'shop.db', "SELECT ';' AS value", [], signal())).rows).toEqual([
    { value: ';' },
  ])
  for (const sql of [
    'DELETE FROM orders',
    'SELECT * FROM orders; DELETE FROM orders',
    'PRAGMA user_version=2',
  ])
    await expect(data.query('session-test', 'shop.db', sql, [], signal())).rejects.toThrow()
  expect(
    (await data.query('session-test', 'shop.db', 'SELECT COUNT(*) AS total FROM orders', [], signal())).rows,
  ).toEqual([{ total: 3 }])
})
it('fails rather than silently discarding rows above the complete-result limit', async () => {
  const limited = new DataCore(Object.assign({}, data.config, { maxResultRows: 2 }))
  await expect(
    limited.query('session-test', 'shop.db', 'SELECT * FROM orders', [], signal()),
  ).rejects.toThrow('row limit')
})
it('terminates a long running worker before settling timeout', async () => {
  const limited = new DataCore(Object.assign({}, data.config, { queryTimeoutMs: 1000 }))
  await expect(
    limited.query(
      'session-test',
      'shop.db',
      'WITH RECURSIVE t(x) AS (SELECT 1 UNION ALL SELECT x+1 FROM t) SELECT SUM(x) FROM t',
      [],
      signal(),
    ),
  ).rejects.toThrow('timed out')
  expect(
    (await data.query('session-test', 'shop.db', 'SELECT COUNT(*) AS total FROM orders', [], signal()))
      .rowCount,
  ).toBe(1)
}, 10000)
it('does not start execution for a cancelled invocation', async () => {
  await expect(
    data.query(
      'session-test',
      'shop.db',
      'SELECT * FROM orders',
      [],
      AbortSignal.abort(new Error('cancelled')),
    ),
  ).rejects.toThrow('cancelled')
})
it('reads immutable schema Markdown and paginates exact versions', async () => {
  const sources = await data.sources('session-test', signal())
  const ref = sources.documents[0]!
  const page = await data.read('session-test', ref.id, ref.version, 0)
  expect(page.markdown).toContain('orders')
  const old = await data.document('session-test', 'Metric', 'business:metric', 'Revenue is unconfirmed.')
  const updated = await data.document(
    'session-test',
    'Metric',
    'business:metric',
    'Revenue means paid_amount.',
  )
  expect(old.id).toBe(updated.id)
  expect(old.version).not.toBe(updated.version)
  expect((await data.read('session-test', old.id, old.version, 0)).markdown).toContain('unconfirmed')
  await expect(data.read('session-test', '../escape', old.version, 0)).rejects.toThrow('Invalid')
})
it('includes all database tables in metadata and permits read-only joins and subqueries', async () => {
  const db = new DatabaseSync(join(root, 'db', 'shop.db'))
  db.exec("CREATE TABLE secret(value TEXT); INSERT INTO secret VALUES ('private');")
  db.close()
  await data.setScope(
    'session-test',
    { version: 2, sources: [{ database: 'shop.db' }], defaultDatabase: 'shop.db' },
    signal(),
  )
  expect(
    (
      await data.query(
        'session-test',
        'shop.db',
        'WITH c AS (SELECT * FROM orders) SELECT COUNT(*) AS total FROM c',
        [],
        signal(),
      )
    ).rows,
  ).toEqual([{ total: 3 }])
  expect(
    (
      await data.query(
        'session-test',
        'shop.db',
        'WITH secret AS (SELECT 1 AS n) SELECT * FROM secret',
        [],
        signal(),
      )
    ).rows,
  ).toEqual([{ n: 1 }])
  for (const sql of [
    'SELECT * FROM secret',
    'SELECT * FROM main.secret',
    'WITH c AS (SELECT * FROM secret) SELECT * FROM c',
    'SELECT * FROM orders WHERE id IN (SELECT 1 FROM secret)',
    'SELECT id FROM orders UNION ALL SELECT 1 FROM secret',
  ])
    expect((await data.query('session-test', 'shop.db', sql, [], signal())).rowCount).toBeGreaterThan(0)
  await expect(data.query('session-test', 'shop.db', 'SELECT * FROM elsewhere.orders', [], signal())).rejects.toThrow('no such table')
  const schema = await data.metadata('session-test', 'shop.db', signal())
  expect(schema.tables.map(table => table.name)).toEqual(['orders', 'secret'])
  expect(
    (await data.metadata('session-test', 'shop.db', signal(), false)).tables.map(table => table.name),
  ).toEqual(['orders', 'secret'])
})
it('rejects unknown databases and table selection while retaining the prior database selection', async () => {
  const scope = {
    version: 2,
    sources: [{ database: 'shop.db' }],
    defaultDatabase: 'shop.db',
  }
  await data.setScope('session-test', scope, signal())
  for (const invalid of [
    { ...scope, defaultDatabase: 'missing.db' },
    { ...scope, sources: [{ database: 'missing.db' }] },
    { ...scope, sources: [{ database: 'shop.db', tables: ['missing'] }] },
    { ...scope, sources: [scope.sources[0], scope.sources[0]] },
  ])
    await expect(data.setScope('session-test', invalid, signal())).rejects.toThrow()
  expect(data.scope('session-test')).toEqual(scope)
  await data.setScope('session-test', { version: 2, sources: [], defaultDatabase: null }, signal())
  expect((await data.sources('session-test', signal())).databases).toEqual([])
  await expect(data.query('session-test', 'shop.db', 'SELECT * FROM orders', [], signal())).rejects.toThrow(
    'not enabled',
  )
})
it('reads uploaded structure Markdown and preserves previously read versions', async () => {
  const first = await data.schemas.upload(
    'shop.db',
    'schema-notes.md',
    '## Revenue\nUse amount; currency is unconfirmed.',
  )
  const sources = await data.sources('session-test', signal())
  const old = sources.documents.find(item => item.source === `source-knowledge:shop.db:schema:${first.id}`)!
  await data.schemas.upload('shop.db', 'schema-notes.md', '## Revenue\nAmount is in CNY.', first)
  const next = (await data.sources('session-test', signal())).documents.find(item => item.source === old.source)!
  expect(old.version).not.toBe(next.version)
  expect((await data.read('session-test', old.id, old.version, 0)).markdown).toContain(
    'currency is unconfirmed',
  )
  const schema = await data.schema('session-test', 'shop.db', signal())
  expect(schema.documents.every(document => document.origin === 'uploaded')).toBe(true)
  expect(schema.markdown).toContain('Amount is in CNY')
  expect(schema.documents.find(item => item.id === first.id)?.version).not.toBe(first.version)
  for (const filename of ['../schema.md', 'schema.html', 'a\\schema.md'])
    await expect(data.schemas.upload('shop.db', filename, 'content')).rejects.toThrow('Markdown')
  await expect(
    data.schemas.upload('shop.db', 'schema-notes.md', 'x'.repeat(data.config.maxSchemaBytes + 1)),
  ).rejects.toThrow('byte limit')
})
it('loads successful session scope once and does not widen explicit empty selections', async () => {
  let reads = 0
  const restored = new DataCore(data.config, undefined, async () => {
    reads++
    return { version: 2, sources: [], defaultDatabase: null }
  })
  await restored.restoreScope('session-test')
  await restored.restoreScope('session-test')
  expect(reads).toBe(1)
  await expect(
    restored.query('session-test', 'shop.db', 'SELECT * FROM orders', [], signal()),
  ).rejects.toThrow('not enabled')
})
it('discovers, searches and preserves business MD versions only for enabled mapped sources', async () => {
  await mkdir(data.config.documentsDirectory)
  await writeFile(
    join(data.config.documentsDirectory, 'sources.json'),
    JSON.stringify({
      version: 1,
      sources: [
        { database: 'shop.db', documents: ['shop-metrics.md'] },
        { database: 'another.db', documents: ['other-metrics.md'] },
      ],
    }),
  )
  await writeFile(
    join(data.config.documentsDirectory, 'shop-metrics.md'),
    '# Business definitions\nRevenue uses paid amounts.\n',
  )
  await writeFile(
    join(data.config.documentsDirectory, 'other-metrics.md'),
    'Unrelated confidential metric.\n',
  )
  const sources = await data.sources('session-test', signal())
  const ref = sources.documents.find(item => item.source === 'business-source:shop.db')!
  expect((await data.read('session-test', ref.id, ref.version, 0)).markdown).toContain(
    'Revenue uses paid amounts',
  )
  expect((await data.search('session-test', 'confidential')).documents).toEqual([])
  expect((await data.search('session-test', 'Revenue uses paid')).documents).toHaveLength(1)
  await data.businesses.uploadKnowledge('shop.db', 'shop.db', 'business.md', 'Exclude refunds.')
  const updated = (await data.sources('session-test', signal())).documents.find(
    item => item.source === ref.source,
  )!
  expect(updated.version).not.toBe(ref.version)
  expect((await data.read('session-test', ref.id, ref.version, 0)).markdown).not.toContain('Exclude refunds')
  expect((await data.read('session-test', updated.id, updated.version, 0)).markdown).toContain(
    'Exclude refunds',
  )
  await data.setScope('session-test', { version: 2, sources: [], defaultDatabase: null }, signal())
  expect((await data.search('session-test', 'Revenue uses paid')).documents).toEqual([])
  await expect(data.business('session-test', 'shop.db')).rejects.toThrow('not enabled')
  expect((await data.business('session-test', 'shop.db', false)).references).toHaveLength(1)
})
it('discovers individual active documents, removes stale search entries and retains exact historical reads', async () => {
  const first = await data.businesses.uploadKnowledge('shop.db', 'shop.db', 'metrics.md', '# Metrics\nCurrent paid metric.')
  await data.businesses.uploadKnowledge('shop.db', 'shop.db', 'refunds.md', '# Refunds\nRefund reconciliation.')
  const entries = (await data.sources('session-test', signal())).documents
    .filter(item => item.source.startsWith('source-knowledge:shop.db:business:'))
  expect(entries).toHaveLength(2)
  const original = (await data.search('session-test', 'Current paid metric')).documents[0]!
  const current = (await data.business('session-test', 'shop.db')).documents.find(item => item.id === first.id)!
  await data.businesses.changeKnowledge('shop.db', 'shop.db', current, { enabled: false })
  expect((await data.search('session-test', 'Current paid metric')).documents).toEqual([])
  expect((await data.search('session-test', 'Refund reconciliation')).documents).toHaveLength(1)
  await data.businesses.changeKnowledge('shop.db', 'shop.db', current, { remove: true })
  expect((await data.search('session-test', 'Current paid metric')).documents).toEqual([])
  expect((await data.read('session-test', original.id, original.version, 0)).markdown).toContain('Current paid metric')
  expect((await data.business('session-test', 'shop.db')).documents.map(item => item.filename)).toEqual(['refunds.md'])
})

it('searches the current version even when content returns to an earlier version', async () => {
  const source = 'metric:test'
  const old = await data.document('session-test', 'Metric', source, 'First metric meaning.')
  await data.document('session-test', 'Metric', source, 'Second metric meaning.')
  const restored = await data.document('session-test', 'Metric', source, 'First metric meaning.')
  expect(restored.version).toBe(old.version)
  expect((await data.search('session-test', 'First metric meaning.')).documents).toHaveLength(1)
  expect((await data.search('session-test', 'Second metric meaning.')).documents).toHaveLength(0)
  const concurrent = await Promise.all(
    [1, 2].map(() => data.document('session-test', 'Concurrent', 'same', 'Same body')),
  )
  expect(concurrent[0]).toEqual(concurrent[1])
})
it('imports CSV into a session-owned source without modifying the original file', async () => {
  const file = join(root, 'sales.csv')
  await writeFile(file, 'region,amount\neast,10\nwest,20\n')
  const imported = await data.import('session-test', file, root, signal())
  const result = await data.query(
    'session-test',
    imported.database,
    'SELECT SUM(amount) AS total FROM data',
    [],
    signal(),
  )
  expect(result.rows).toEqual([{ total: 30 }])
  expect(await readFile(file, 'utf8')).toBe('region,amount\neast,10\nwest,20\n')
  await expect(data.import('session-test', file, join(root, 'db'), signal())).rejects.toThrow('inside')
}, 10000)
it('binds report values to complete data and disables raw HTML', async () => {
  const result = await data.query(
    'session-test',
    'shop.db',
    'SELECT SUM(amount) AS total FROM orders',
    [],
    signal(),
  )
  const output = await report(
    data,
    'session-test',
    '销售报告',
    `总金额：{{result:${result.resultId}:0:total}}\n\n<script>alert(1)</script>`,
    [result.resultId],
    ['md', 'html'],
    signal(),
  )
  expect(output.artifacts).toHaveLength(2)
  for (const ref of output.artifacts) {
    const bytes = await readArtifact(data, 'session-test', ref.artifactId, ref.filename)
    expect(bytes.toString()).toContain('60')
    if (ref.filename.endsWith('.html')) expect(bytes.toString()).not.toContain('<script>')
  }
  await expect(
    report(
      data,
      'session-test',
      'Invalid',
      `{{result:${result.resultId}:0:missing}}`,
      [result.resultId],
      ['md'],
      signal(),
    ),
  ).rejects.toThrow('placeholder')
  const plot = await chart(data, 'session-test', result.resultId, 'total', 'total', '总额')
  expect((await readArtifact(data, 'session-test', plot.artifactId, plot.filename)).toString()).toContain(
    '60',
  )
})

it('embeds verified charts in a Chinese PDF and preserves report revision parents', async () => {
  const result = await data.query(
    'session-test',
    'shop.db',
    'SELECT region,SUM(amount) AS total FROM orders GROUP BY region',
    [],
    signal(),
  )
  const plot = await chart(data, 'session-test', result.resultId, 'region', 'total', '区域销售')
  const original = await report(
    data,
    'session-test',
    '销售报告',
    `区域金额：{{result:${result.resultId}:0:total}}`,
    [result.resultId],
    ['md', 'html', 'pdf'],
    signal(),
    { chartIds: [plot.artifactId], language: 'zh-CN' },
  )
  const html = original.artifacts.find(ref => ref.filename === 'report.html')!
  expect((await readArtifact(data, 'session-test', html.artifactId, html.filename)).toString()).toContain(
    'data:image/svg+xml;base64,',
  )
  const pdf = original.artifacts.find(ref => ref.filename === 'report.pdf')!
  expect(
    (await readArtifact(data, 'session-test', pdf.artifactId, pdf.filename)).subarray(0, 5).toString(),
  ).toBe('%PDF-')
  const revised = await report(
    data,
    'session-test',
    '销售报告修订',
    '增加限制说明',
    [result.resultId],
    ['md'],
    signal(),
    { revisionOf: { reportId: original.reportId, version: original.version } },
  )
  expect(revised.reportId).toBe(original.reportId)
  expect(revised.version).not.toBe(original.version)
  expect(revised.document.path).not.toBe(original.document.path)
  expect(await readFile(original.document.path, 'utf8')).toContain(
    '区域金额',
  )
}, 20000)
