/** Source-owned Markdown collections with immutable content and serialized index updates. */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import { z } from 'zod'
import type { Config } from './config.ts'
import { DocumentId } from './brand.ts'

const filenameSchema = z.string().max(200).refine(
  value => basename(value) === value && !/[\\/\x00-\x1f]/u.test(value) && /\.md$/iu.test(value),
  'Upload a Markdown file with a safe .md basename.',
)
const legacySchema = z.object({
  version: z.string().regex(/^[a-f0-9]{64}$/u),
  filename: filenameSchema,
  uploadedAt: z.string(),
})
const uploadSchema = legacySchema.extend({
  id: z.string().regex(/^[a-f0-9]{20}$/u).transform(DocumentId),
  enabled: z.boolean(),
})
const collectionSchema = z.object({
  version: z.literal(1),
  documents: z.array(uploadSchema),
  disabledReferences: z.array(z.string().regex(/^[a-f0-9]{20}$/u).transform(DocumentId)),
})
const referenceSchema = z.object({ filename: filenameSchema, category: z.enum(['schema', 'business']) })
const manifestSchema = z.discriminatedUnion('version', [
  z.object({ version: z.literal(1), sources: z.array(z.object({
    database: z.string().min(1), documents: z.array(filenameSchema),
  })) }),
  z.object({ version: z.literal(2), sources: z.array(z.object({
    database: z.string().min(1), documents: z.array(referenceSchema),
  })) }),
])
/** Configured source references; version 1 contains business documents matched by database name. */
export interface SourceManifest {
  version: 1 | 2
  sources: Array<{ database: string; documents: Array<z.infer<typeof referenceSchema>> }>
}
/** Structure or business Markdown associated with one database. */
export interface SourceKnowledge {
  database: string
  markdown: string
  documents: KnowledgeDocument[]
  references: Array<{ filename: string; version: string }>
}
/** A current uploaded document; content remains addressed by its SHA-256 version. */
export type MarkdownUpload = z.infer<typeof uploadSchema>
/** Individually readable configured or uploaded Markdown. */
export interface KnowledgeDocument extends Omit<MarkdownUpload, 'uploadedAt'> {
  uploadedAt: string | null
  origin: 'configured' | 'uploaded'
  markdown: string
}
/** Current documents and disabled configured references for one source category. */
export interface MarkdownCollection {
  documents: KnowledgeDocument[]
  disabledReferences: DocumentId[]
}
/** Stable knowledge identity scoped by its owning source and category.
 * @param value - generated identity or configured filename.
 * @returns branded twenty-character digest.
 */
export function knowledgeId(value: string): DocumentId {
  return DocumentId(createHash('sha256').update(value).digest('hex').slice(0, 20))
}

/** Multiple documents per source; deletion removes discovery, never historical content. */
export class SourceMarkdownStore {
  /** @param config - upload limits, writer timeout and evidence directory.
   * @param category - separate storage for schema and business documents.
   */
  constructor(
    private readonly config: Config,
    private readonly category: 'source-schemas' | 'source-business',
  ) {}

  /** Read source mappings without loading document contents; missing mappings are empty.
   * @returns categorized references, retaining version 1's database-name matching.
   */
  async manifest(): Promise<SourceManifest> {
    let raw: string
    try { raw = await readFile(resolve(this.config.documentsDirectory, 'sources.json'), 'utf8') }
    catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
        return { version: 2, sources: [] }
      throw error
    }
    if (Buffer.byteLength(raw) > this.config.maxSchemaBytes)
      throw new Error('Source document mapping exceeds the Markdown byte limit.')
    const parsed = manifestSchema.parse(JSON.parse(raw))
    const manifest: SourceManifest = { version: parsed.version, sources: parsed.sources.map(source => ({
      database: source.database,
      documents: source.documents.map(document => typeof document === 'string'
        ? { filename: document, category: 'business' } : document),
    })) }
    if (new Set(manifest.sources.map(source => source.database)).size !== manifest.sources.length)
      throw new Error('Source document mapping repeats a database.')
    for (const source of manifest.sources)
      if (new Set(source.documents.map(document => `${document.category}:${document.filename.toLowerCase()}`)).size !== source.documents.length)
        throw new Error('Source document mapping repeats a document.')
    return manifest
  }

  private async configured(database: string, name: string): Promise<string[]> {
    const manifest = await this.manifest()
    const source = manifest.sources.find(source => source.database === database
      || (manifest.version === 1 && source.database === name))
    const category = this.category === 'source-schemas' ? 'schema' : 'business'
    return source?.documents.filter(document => document.category === category).map(document => document.filename) ?? []
  }

  /** Read only this source's configured and uploaded Markdown, without querying the database.
   * @param database - public source key.
   * @param name - database name for legacy version 1 mappings.
   * @returns individually managed documents and combined active content.
   */
  async render(database: string, name: string): Promise<SourceKnowledge> {
    return this.assemble(database, name, await this.collection(database))
  }

  private async assemble(database: string, name: string, collection: MarkdownCollection): Promise<SourceKnowledge> {
    const references: SourceKnowledge['references'] = []
    const documents: KnowledgeDocument[] = []
    const filenames = await this.configured(database, name)
    if (filenames.length) {
      const directory = await realpath(resolve(this.config.documentsDirectory))
      for (const filename of filenames) {
        const path = await realpath(join(directory, filename))
        const child = relative(directory, path)
        if (isAbsolute(child) || child === '..' || child.startsWith(`..${sep}`))
          throw new Error('Source document resolves outside documentsDirectory.')
        const markdown = await readFile(path, 'utf8')
        const version = createHash('sha256').update(markdown).digest('hex')
        const id = knowledgeId(`configured:${filename}`)
        const enabled = !collection.disabledReferences.includes(id)
        documents.push({ id, filename, version, uploadedAt: null, enabled, origin: 'configured', markdown })
        if (enabled) references.push({ filename, version })
      }
    }
    documents.push(...collection.documents)
    if (new Set(documents.map(document => document.filename.toLowerCase())).size !== documents.length)
      throw new Error('Source knowledge repeats a document filename; rename the configured or uploaded document.')
    const markdown = documents.filter(document => document.enabled)
      .map(document => `## ${document.filename}\n\n${document.markdown}`).join('\n\n')
    if (Buffer.byteLength(markdown) > this.config.maxSchemaBytes)
      throw new Error('Combined source knowledge exceeds the Markdown byte limit.')
    return { database, markdown, documents, references }
  }

  /** Upload a document after validating the complete active source category.
   * @param database - public source key.
   * @param name - database name for legacy mappings.
   * @param filename - uploaded Markdown basename.
   * @param markdown - user-authored document content.
   * @param replace - uploaded document and expected version, omitted for addition.
   * @returns committed upload metadata.
   */
  async uploadKnowledge(database: string, name: string, filename: string, markdown: string,
    replace?: { id: DocumentId; version: string }): Promise<MarkdownUpload> {
    if ((await this.configured(database, name)).some(item => item.toLowerCase() === filename.toLowerCase()))
      throw new Error('This filename belongs to a configured reference. Add your document with a distinct filename.')
    return this.upload(database, filename, markdown, replace, async (collection) => {
      await this.assemble(database, name, collection)
    })
  }

  /** Change a document after validating the complete active source category.
   * @param database - public source key.
   * @param name - database name for legacy mappings.
   * @param document - current entry and expected content version.
   * @param action - enabled state or removal of an uploaded entry.
   */
  async changeKnowledge(database: string, name: string, document: KnowledgeDocument,
    action: { enabled: boolean } | { remove: true }): Promise<void> {
    await this.change(database, document, action, async (collection) => {
      await this.assemble(database, name, collection)
    })
  }

  private directory(database: string): string {
    return resolve(this.config.artifactsDirectory, this.category, createHash('sha256').update(database).digest('hex'))
  }

  private async index(database: string): Promise<z.infer<typeof collectionSchema>> {
    const directory = this.directory(database)
    let raw: string
    try {
      raw = await readFile(join(directory, 'collection.v1.json'), 'utf8')
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error
      let legacy: string
      try {
        legacy = await readFile(join(directory, 'current.json'), 'utf8')
      } catch (cause) {
        if (cause instanceof Error && 'code' in cause && cause.code === 'ENOENT')
          return { version: 1, documents: [], disabledReferences: [] }
        throw cause
      }
      return {
        version: 1,
        documents: [{ ...legacySchema.parse(JSON.parse(legacy)), id: knowledgeId('legacy'), enabled: true }],
        disabledReferences: [],
      }
    }
    if (Buffer.byteLength(raw) > this.config.maxSchemaBytes) throw new Error('Knowledge index exceeds the byte limit.')
    const index = collectionSchema.parse(JSON.parse(raw))
    if (new Set(index.documents.map(item => item.id)).size !== index.documents.length)
      throw new Error('Knowledge index repeats a document identifier.')
    return index
  }

  private async load(database: string, metadata: MarkdownUpload): Promise<KnowledgeDocument> {
    const markdown = await readFile(join(this.directory(database), `${metadata.version}.md`), 'utf8')
    if (createHash('sha256').update(markdown).digest('hex') !== metadata.version)
      throw new Error('Uploaded Markdown differs from its recorded version.')
    return { ...metadata, origin: 'uploaded', markdown }
  }

  /** Read all current documents without modifying the legacy upload or historical files.
   * @param database - known source key.
   * @returns individually readable uploads and configured-reference preferences.
   */
  async collection(database: string): Promise<MarkdownCollection> {
    const index = await this.index(database)
    return {
      documents: await Promise.all(index.documents.map(item => this.load(database, item))),
      disabledReferences: index.disabledReferences,
    }
  }

  private async mutate(
    database: string,
    change: (index: z.infer<typeof collectionSchema>) => Promise<void> | void,
    validate?: (collection: MarkdownCollection) => Promise<void>,
  ): Promise<void> {
    const directory = this.directory(database)
    await mkdir(directory, { recursive: true })
    const path = join(directory, 'collection.v1.json')
    await withFileLock(path, async () => {
      const index = await this.index(database)
      await change(index)
      if (index.documents.length > this.config.maxKnowledgeDocuments)
        throw new Error('Knowledge document count exceeds the configured limit.')
      const documents = await Promise.all(index.documents.map(item => this.load(database, item)))
      if (documents.reduce((size, item) => size + Buffer.byteLength(item.markdown), 0) > this.config.maxSchemaBytes)
        throw new Error('Combined uploaded Markdown exceeds the byte limit.')
      await validate?.({ documents, disabledReferences: index.disabledReferences })
      const raw = JSON.stringify(index)
      if (Buffer.byteLength(raw) > this.config.maxSchemaBytes) throw new Error('Knowledge index exceeds the byte limit.')
      await writeFileAtomic(path, raw, { mode: 0o600 })
    }, { waitMs: this.config.documentWriteTimeoutMs })
  }

  /** Add a distinct document or replace an explicitly selected current version.
   * @param database - validated source key.
   * @param filename - safe Markdown basename; duplicate names require explicit replacement.
   * @param markdown - user-authored reference content.
   * @param replace - selected identity and expected content version, omitted for addition.
   * @param validate - optional owner validation before the collection commits.
   * @returns committed document identity, version and enabled state.
   */
  async upload(
    database: string,
    filename: string,
    markdown: string,
    replace?: { id: DocumentId; version: string },
    validate?: (collection: MarkdownCollection) => Promise<void>,
  ): Promise<MarkdownUpload> {
    filenameSchema.parse(filename)
    if (!markdown.trim() || Buffer.byteLength(markdown) > this.config.maxSchemaBytes)
      throw new Error('Markdown is empty or exceeds the upload byte limit.')
    const metadata: MarkdownUpload = {
      id: replace?.id ?? knowledgeId(randomUUID()),
      filename,
      version: createHash('sha256').update(markdown).digest('hex'),
      uploadedAt: new Date().toISOString(),
      enabled: true,
    }
    await this.mutate(database, async (index) => {
      const previous = replace ? index.documents.find(item => item.id === replace.id) : undefined
      if (replace && (!previous || previous.version !== replace.version))
        throw new Error('Document changed; refresh the knowledge library before replacing it.')
      if (index.documents.some(item => item.id !== metadata.id && item.filename.toLowerCase() === filename.toLowerCase()))
        throw new Error('A document with this filename already exists. Select it to replace its content.')
      if (previous) metadata.enabled = previous.enabled
      try {
        await writeFile(join(this.directory(database), `${metadata.version}.md`), markdown, { flag: 'wx', mode: 0o600 })
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'EEXIST')) throw error
      }
      index.documents = previous
        ? index.documents.map(item => item.id === metadata.id ? metadata : item)
        : [...index.documents, metadata]
    }, validate)
    return metadata
  }

  /** Enable, disable or remove one entry without deleting immutable evidence.
   * @param database - validated source key.
   * @param document - currently resolved document, including its expected version.
   * @param action - desired enabled state or removal of an uploaded entry.
   * @param validate - optional owner validation before committing the new selection.
   */
  async change(
    database: string,
    document: KnowledgeDocument,
    action: { enabled: boolean } | { remove: true },
    validate?: (collection: MarkdownCollection) => Promise<void>,
  ): Promise<void> {
    if (document.origin === 'configured' && 'remove' in action)
      throw new Error('Configured references can be disabled, not removed from the project.')
    await this.mutate(database, (index) => {
      if (document.origin === 'configured') {
        if ('enabled' in action)
          index.disabledReferences = action.enabled
            ? index.disabledReferences.filter(id => id !== document.id)
            : [...new Set([...index.disabledReferences, document.id])]
        return
      }
      const current = index.documents.find(item => item.id === document.id)
      if (!current || current.version !== document.version)
        throw new Error('Document changed; refresh the knowledge library before editing it.')
      if ('remove' in action) index.documents = index.documents.filter(item => item.id !== document.id)
      else current.enabled = action.enabled
    }, validate)
  }
}
