/** Uniform source-linked structure and business Markdown management. */
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { SourceMarkdownStore } from '../src/source-markdown.ts'

let directory: string
let config: Config
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'dsh-source-documents-'))
  config = new Config(Object.assign(Config(), {
    artifactsDirectory: join(directory, 'evidence'),
    documentsDirectory: join(directory, 'docs'),
  }))
  await mkdir(config.documentsDirectory)
})
afterEach(async () => {
  await rm(directory, { recursive: true, force: true })
})

it.each(['source-schemas', 'source-business'] as const)('binds %s references to exact source keys and manages their active state', async (category) => {
  const kind = category === 'source-schemas' ? 'schema' : 'business'
  await writeFile(join(config.documentsDirectory, 'sources.json'), JSON.stringify({ version: 2,
    sources: [{ database: 'mysql:connection-a:sales', documents: [{ filename: 'notes.md', category: kind }] }] }))
  await writeFile(join(config.documentsDirectory, 'notes.md'), '# Supplied document\n\nConfirmed fields and meanings.')
  const store = new SourceMarkdownStore(config, category)
  const source = await store.render('mysql:connection-a:sales', 'sales')
  expect(source.documents).toMatchObject([{ filename: 'notes.md', origin: 'configured', enabled: true }])
  expect((await store.render('mysql:connection-b:sales', 'sales')).documents).toEqual([])
  await store.changeKnowledge('mysql:connection-a:sales', 'sales', source.documents[0]!, { enabled: false })
  expect((await store.render('mysql:connection-a:sales', 'sales')).markdown).toBe('')
})

it('combines mapped business references and an independent versioned upload without changing schema uploads', async () => {
  await writeFile(
    join(config.documentsDirectory, 'sources.json'),
    JSON.stringify({ version: 1, sources: [{ database: 'sales', documents: ['metrics.md'] }] }),
  )
  await writeFile(join(config.documentsDirectory, 'metrics.md'), '# Revenue\nAmount is in cents.\n')
  const business = new SourceMarkdownStore(config, 'source-business')
  const schema = new SourceMarkdownStore(config, 'source-schemas')
  await schema.upload('sales', 'schema.md', 'Structural notes.')
  const first = await business.uploadKnowledge('sales', 'sales', 'business.md', 'Exclude cancelled orders.')
  const rendered = await business.render('sales', 'sales')
  expect(rendered.markdown).toContain('Amount is in cents')
  expect(rendered.markdown).toContain('Exclude cancelled orders')
  expect(rendered.references[0]?.version).toMatch(/^[a-f0-9]{64}$/u)
  expect(rendered.documents.find(item => item.id === first.id)?.version).toBe(first.version)
  expect((await schema.collection('sales')).documents[0]?.markdown).toBe('Structural notes.')
  expect((await business.render('other', 'other')).references).toEqual([])
  await business.uploadKnowledge('sales', 'sales', 'business.md', 'Include completed orders.', first)
  expect((await business.render('sales', 'sales')).documents.find(item => item.id === first.id)?.version).not.toBe(first.version)
  expect(
    await readFile(
      join(
        config.artifactsDirectory,
        'source-business',
        createHash('sha256').update('sales').digest('hex'),
        `${first.version}.md`,
      ),
      'utf8',
    ),
  ).toBe('Exclude cancelled orders.')
})

it.each([
  [{ filename: '../escape.md', category: 'schema' }],
  [{ filename: 'fields.md', category: 'unknown' }],
  [{ filename: 'fields.md' }],
  [{ filename: 'fields.md', category: 'schema' }, { filename: 'FIELDS.md', category: 'schema' }],
].map(documents => ({ documents })))('rejects invalid categorized source references before reading their files: %j', async ({ documents }) => {
  await writeFile(join(config.documentsDirectory, 'sources.json'), JSON.stringify({ version: 2,
    sources: [{ database: 'sales', documents }] }))
  await expect(new SourceMarkdownStore(config, 'source-schemas').render('sales', 'sales')).rejects.toThrow()
})

it('rejects a configured filename that collides with an existing upload', async () => {
  const store = new SourceMarkdownStore(config, 'source-schemas')
  await store.uploadKnowledge('sales', 'sales', 'fields.md', 'Uploaded structure.')
  await writeFile(join(config.documentsDirectory, 'fields.md'), 'Configured structure.')
  await writeFile(join(config.documentsDirectory, 'sources.json'), JSON.stringify({ version: 2,
    sources: [{ database: 'sales', documents: [{ filename: 'fields.md', category: 'schema' }] }] }))
  await expect(store.render('sales', 'sales')).rejects.toThrow('filename')
})

it('rejects a complete over-limit knowledge upload before replacing its current version', async () => {
  const business = new SourceMarkdownStore(config, 'source-business')
  const first = await business.uploadKnowledge('sales', 'sales', 'business.md', 'Confirmed meaning.')
  const limited = new SourceMarkdownStore(Object.assign({}, config, { maxSchemaBytes: 200 }), 'source-business')
  await expect(limited.uploadKnowledge('sales', 'sales', 'business.md', '界'.repeat(200), first)).rejects.toThrow(
    'byte limit',
  )
  expect((await business.collection('sales')).documents[0]?.version).toBe(first.version)
  for (const filename of ['../business.md', 'business.html', 'a\\business.md'])
    await expect(business.uploadKnowledge('sales', 'sales', filename, 'Notes')).rejects.toThrow('Markdown')
})

it('fails malformed, missing and escaping document mappings instead of loading them globally', async () => {
  const business = new SourceMarkdownStore(config, 'source-business')
  for (const documents of [['../escape.md'], ['document.html'], ['a\\escape.md']]) {
    await writeFile(
      join(config.documentsDirectory, 'sources.json'),
      JSON.stringify({ version: 1, sources: [{ database: 'sales', documents }] }),
    )
    await expect(business.render('sales', 'sales')).rejects.toThrow('Markdown')
  }
  await writeFile(
    join(config.documentsDirectory, 'sources.json'),
    JSON.stringify({ version: 1, sources: [{ database: 'sales', documents: ['missing.md'] }] }),
  )
  await expect(business.render('sales', 'sales')).rejects.toThrow()
})

it('adds independent documents, replaces only the selected version, and preserves removed content', async () => {
  const business = new SourceMarkdownStore(config, 'source-business')
  const first = await business.uploadKnowledge('sales', 'sales', 'metrics.md', '# Metrics\nAmounts use cents.')
  const second = await business.uploadKnowledge('sales', 'sales', 'refunds.md', '# Refunds\nCheck settled status.')
  expect((await business.render('sales', 'sales')).documents.map(item => item.filename)).toEqual(['metrics.md', 'refunds.md'])
  await expect(business.uploadKnowledge('sales', 'sales', 'metrics.md', 'Unselected overwrite')).rejects.toThrow('already exists')
  const replacement = await business.uploadKnowledge('sales', 'sales', 'metrics.md', '# Metrics\nAmounts use yuan.', first)
  await expect(business.uploadKnowledge('sales', 'sales', 'metrics.md', 'Stale edit', first)).rejects.toThrow('changed')
  const current = (await business.render('sales', 'sales')).documents
  expect(current.find(item => item.id === second.id)?.markdown).toContain('Check settled status')
  await business.changeKnowledge('sales', 'sales', current.find(item => item.id === replacement.id)!, { remove: true })
  expect((await business.render('sales', 'sales')).documents.map(item => item.id)).toEqual([second.id])
  const path = join(config.artifactsDirectory, 'source-business', createHash('sha256').update('sales').digest('hex'))
  expect(await readFile(join(path, `${first.version}.md`), 'utf8')).toContain('cents')
  expect(await readFile(join(path, `${replacement.version}.md`), 'utf8')).toContain('yuan')
})

it('disables configured references individually without removing their source files', async () => {
  await writeFile(join(config.documentsDirectory, 'sources.json'), JSON.stringify({ version: 1,
    sources: [{ database: 'sales', documents: ['metrics.md', 'refunds.md'] }] }))
  await writeFile(join(config.documentsDirectory, 'metrics.md'), '# Metrics\nCount paid records.')
  await writeFile(join(config.documentsDirectory, 'refunds.md'), '# Refunds\nCheck refund state.')
  const business = new SourceMarkdownStore(config, 'source-business')
  const first = (await business.render('sales', 'sales')).documents[0]!
  await business.changeKnowledge('sales', 'sales', first, { enabled: false })
  const changed = await business.render('sales', 'sales')
  expect(changed.documents).toHaveLength(2)
  expect(changed.markdown).not.toContain('Count paid records')
  expect(changed.markdown).toContain('Check refund state')
  await expect(business.changeKnowledge('sales', 'sales', first, { remove: true })).rejects.toThrow('disabled')
  await expect(business.uploadKnowledge('sales', 'sales', 'metrics.md', 'Duplicate configured file')).rejects.toThrow('configured')
  await business.changeKnowledge('sales', 'sales', changed.documents[0]!, { enabled: true })
  expect((await business.render('sales', 'sales')).markdown).toContain('Count paid records')
})

it('imports the legacy single upload without rewriting it or reviving a removed entry', async () => {
  const path = join(config.artifactsDirectory, 'source-schemas', createHash('sha256').update('sales').digest('hex'))
  await mkdir(path, { recursive: true })
  const markdown = '# Legacy\nOld schema supplement.'
  const version = createHash('sha256').update(markdown).digest('hex')
  const legacy = JSON.stringify({ filename: 'legacy.md', version, uploadedAt: '2026-10-01T00:00:00Z' })
  await writeFile(join(path, `${version}.md`), markdown)
  await writeFile(join(path, 'current.json'), legacy)
  const schemas = new SourceMarkdownStore(config, 'source-schemas')
  const old = (await schemas.collection('sales')).documents[0]!
  await schemas.upload('sales', 'new.md', '# New\nSecond supplement.')
  expect((await schemas.collection('sales')).documents).toHaveLength(2)
  await schemas.change('sales', old, { remove: true })
  expect((await new SourceMarkdownStore(config, 'source-schemas').collection('sales')).documents.map(item => item.filename)).toEqual(['new.md'])
  expect(await readFile(join(path, 'current.json'), 'utf8')).toBe(legacy)
})

it('serializes overlapping writers from independent stores without losing either addition', async () => {
  const first = new SourceMarkdownStore(config, 'source-schemas')
  const second = new SourceMarkdownStore(config, 'source-schemas')
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>((resolve) => { release = resolve })
  const started = new Promise<void>((resolve) => { entered = resolve })
  const one = first.upload('sales', 'one.md', 'First reference.', undefined, async () => { entered(); await held })
  await started
  const two = second.upload('sales', 'two.md', 'Second reference.')
  release()
  await Promise.all([one, two])
  expect((await first.collection('sales')).documents.map(item => item.filename).sort()).toEqual(['one.md', 'two.md'])
  expect((await second.collection('other')).documents).toEqual([])
})

it('rejects count and combined-byte excess before publishing a new collection', async () => {
  const schemas = new SourceMarkdownStore(Object.assign({}, config, { maxKnowledgeDocuments: 1 }), 'source-schemas')
  await schemas.upload('sales', 'one.md', 'One reference.')
  await expect(schemas.upload('sales', 'two.md', 'Two references.')).rejects.toThrow('count')
  const limited = new SourceMarkdownStore(Object.assign({}, config, { maxSchemaBytes: 1024 }), 'source-schemas')
  await expect(limited.upload('sales', 'large.md', 'x'.repeat(1024))).rejects.toThrow('byte limit')
  expect((await schemas.collection('sales')).documents.map(item => item.filename)).toEqual(['one.md'])
})
