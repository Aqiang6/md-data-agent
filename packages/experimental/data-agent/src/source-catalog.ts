/** Database connections stored by the credential provider; public views never contain secrets. */
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { credentialKey, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import type { Config } from './config.ts'
import { ConnectionId } from './brand.ts'
import { isSqliteDatabaseName, listDatabases, resolveDatabasePath } from './databases.ts'

// Persisted connection keys retain their namespace across plugin renames.
const CONNECTION_NAMESPACE = 'glm-db'

/** Credential operations used by connection management. */
export type ConnectionCredentials = Pick<
  CredentialProvider,
  'resolve' | 'listRecords' | 'readRecord' | 'modifyRecord' | 'deleteRecord'
>
/** Late service lookup permits legacy profiles without credential storage. */
export type CredentialLookup = ConnectionCredentials | (() => ConnectionCredentials | undefined)
/** Isolated worker execution owned by the data runtime. */
export type SourceExecutor = (input: Record<string, unknown>, signal: AbortSignal) => Promise<unknown>

/** Admitted connection form; used only by the human configuration API. */
export const connectionInputSchema = z.object({
  label: z.string().trim().min(1).max(100),
  host: z
    .string()
    .trim()
    .regex(/^[a-zA-Z0-9.[\]:_-]+$/u)
    .default('localhost'),
  port: z.number().int().min(1).max(65535).default(3306),
  username: z.string().max(128).default(''),
  password: z.string().max(4096).default(''),
  credentialEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
    .optional(),
  tls: z.boolean().default(false),
  databases: z.array(z.string().min(1).max(64)).default([]),
})
const connectionSchema = z.object({
  id: z.uuid().transform(ConnectionId),
  label: z.string(),
  host: z.string(),
  port: z.number().int(),
  username: z.string(),
  tls: z.boolean(),
  databases: z.array(z.string()),
  credentialEnv: z.string().optional(),
})
const storedSchema = z.object({
  version: z.literal(1),
  connection: connectionSchema,
  url: z.string().optional(),
})
const resultSchema = z.object({ rows: z.array(z.record(z.string(), z.unknown())) })

/** Public connection metadata, excluding password and connection URL. */
export type DatabaseConnection = z.infer<typeof connectionSchema>
/** Discovered database identity and its owner, safe for the browser and model. */
export interface SourceInfo {
  id: string
  name: string
  kind: 'sqlite' | 'mysql'
  connectionId?: ConnectionId
  connectionLabel?: string
}
/** Private worker target; never return this to the browser or model. */
export type SourceTarget =
  | { action: 'sqlite'; path: string }
  | { action: 'mysql'; database: string; url: string; tls: boolean }

/** Durable connection catalog plus legacy configured databases. */
export class SourceCatalog {
  /** @param config - legacy source paths and limits.
   * @param execute - cancellable data worker.
   * @param credentials - optional provider; required for saved connections.
   */
  constructor(
    private readonly config: Config,
    private readonly execute: SourceExecutor,
    private readonly credentialProvider?: CredentialLookup,
  ) {}

  private get credentials(): ConnectionCredentials | undefined {
    return typeof this.credentialProvider === 'function' ? this.credentialProvider() : this.credentialProvider
  }

  private requireCredentials(): ConnectionCredentials {
    if (!this.credentials)
      throw new Error('A credential storage provider is required to save database connections.')
    return this.credentials
  }

  private async legacyUrl(env: string): Promise<string> {
    const value = this.credentials
      ? (await this.credentials.resolve(credentialRef(env)))?.value
      : process.env[env]
    if (!value) throw new Error(`Database credential reference ${env} is not configured.`)
    this.parseUrl(value)
    return value
  }

  private parseUrl(url: string): URL {
    try {
      const parsed = new URL(url)
      if (parsed.protocol !== 'mysql:' || !parsed.hostname || parsed.hash || parsed.search)
        throw new Error('Unsupported database URL.')
      return parsed
    } catch (_error) {
      throw new Error('The database credential must be a mysql:// connection URL without query parameters.')
    }
  }

  private async formUrl(input: z.infer<typeof connectionInputSchema>): Promise<string> {
    if (input.credentialEnv) return this.legacyUrl(input.credentialEnv)
    if (!input.username) throw new Error('A database username is required.')
    let url: URL
    try {
      url = new URL(`mysql://${input.host}:${input.port}`)
    } catch (_error) {
      throw new Error('Invalid database host or port; bracket IPv6 addresses.')
    }
    url.username = input.username
    url.password = input.password
    return url.href
  }

  /** Enumerate saved connections without resolving their credentials.
   * @returns browser-safe connection metadata.
   */
  async connections(): Promise<DatabaseConnection[]> {
    if (!this.credentials) return []
    const connections: DatabaseConnection[] = []
    for (const entry of await this.credentials.listRecords()) {
      if (!String(entry.key).startsWith(`${CONNECTION_NAMESPACE}/connection-`)) continue
      const record = await this.credentials.readRecord(entry.key)
      if (record?.kind !== 'grant') throw new Error('Invalid stored database connection record.')
      const connection = storedSchema.parse(record.payload).connection
      if (String(entry.key) !== `${CONNECTION_NAMESPACE}/connection-${connection.id}`)
        throw new Error('Database connection record identifier differs from its key.')
      connections.push(connection)
    }
    return connections.sort((a, b) => a.label.localeCompare(b.label))
  }

  /** Test a form through a read-only metadata query without saving it.
   * @param raw - untrusted form fields.
   * @param signal - caller cancellation.
   * @returns accessible business database names, not secrets.
   */
  async test(raw: unknown, signal: AbortSignal): Promise<{ databases: string[] }> {
    const input = connectionInputSchema.parse(raw)
    const url = await this.formUrl(input)
    const result = resultSchema.parse(
      await this.execute(
        {
          action: 'mysql',
          url,
          tls: input.tls,
          sql: "SELECT SCHEMA_NAME AS name FROM information_schema.SCHEMATA WHERE SCHEMA_NAME NOT IN ('information_schema','mysql','performance_schema','sys') ORDER BY SCHEMA_NAME",
        },
        signal,
      ),
    )
    return { databases: result.rows.map(row => z.string().parse(row.name)) }
  }

  /** Save a tested connection and only its explicitly selected databases.
   * @param raw - submitted form including selected schema names.
   * @param signal - caller cancellation.
   * @returns non-secret metadata.
   */
  async add(raw: unknown, signal: AbortSignal): Promise<DatabaseConnection> {
    const credentials = this.requireCredentials()
    const input = connectionInputSchema.parse(raw)
    const { databases } = await this.test(input, signal)
    if (!input.databases.length || input.databases.some(name => !databases.includes(name)))
      throw new Error('Select at least one accessible database from the connection test.')
    const url = await this.formUrl(input)
    const parsed = this.parseUrl(url)
    const connection: DatabaseConnection = {
      id: ConnectionId(randomUUID()),
      label: input.label,
      host: parsed.hostname,
      port: Number(parsed.port || 3306),
      username: decodeURIComponent(parsed.username),
      tls: input.tls,
      databases: [...new Set(input.databases)],
      ...(input.credentialEnv ? { credentialEnv: input.credentialEnv } : {}),
    }
    await credentials.modifyRecord(credentialKey(CONNECTION_NAMESPACE, `connection-${connection.id}`), () => Promise.resolve({
      kind: 'grant',
      payload: { version: 1, connection, ...(input.credentialEnv ? {} : { url }) },
    }))
    return connection
  }

  /** Remove a saved connection, never its remote databases.
   * @param id - stored connection UUID.
   */
  async remove(id: string): Promise<void> {
    const admitted = z.uuid().parse(id)
    await this.requireCredentials().deleteRecord(credentialKey(CONNECTION_NAMESPACE, `connection-${admitted}`))
  }

  private async saved(id: string): Promise<{ connection: DatabaseConnection; url: string }> {
    const admitted = z.uuid().parse(id)
    const record = await this.requireCredentials().readRecord(
      credentialKey(CONNECTION_NAMESPACE, `connection-${admitted}`),
    )
    if (record?.kind !== 'grant') throw new Error('Unknown saved database connection.')
    const stored = storedSchema.parse(record.payload)
    const url = stored.connection.credentialEnv
      ? await this.legacyUrl(stored.connection.credentialEnv)
      : stored.url
    if (!url) throw new Error('Saved database credential is missing.')
    this.parseUrl(url)
    return { connection: stored.connection, url }
  }

  /** List configured and saved database sources.
   * @returns stable source keys and display names.
   */
  async list(): Promise<SourceInfo[]> {
    const sources: SourceInfo[] = listDatabases(this.config).map(id => ({
      id,
      name: id,
      kind: isSqliteDatabaseName(id) ? 'sqlite' : 'mysql',
    }))
    for (const connection of await this.connections())
      for (const name of connection.databases)
        sources.push({
          id: `mysql:${connection.id}:${name}`,
          name,
          kind: 'mysql',
          connectionId: connection.id,
          connectionLabel: connection.label,
        })
    return sources
  }

  /** Resolve a known source into private worker connection fields.
   * @param id - listed source key.
   * @returns file or credential-bearing target for the worker only.
   */
  async target(id: string): Promise<SourceTarget> {
    const source = (await this.list()).find(item => item.id === id)
    if (!source) throw new Error('Unknown configured data source.')
    if (source.kind === 'sqlite')
      return { action: 'sqlite', path: resolveDatabasePath(this.config.directory, id) }
    if (source.connectionId) {
      const saved = await this.saved(source.connectionId)
      return { action: 'mysql', database: source.name, url: saved.url, tls: saved.connection.tls }
    }
    return {
      action: 'mysql',
      database: source.name,
      url: await this.legacyUrl(this.config.mysqlUrlEnv),
      tls: false,
    }
  }

  /** Create a new empty database through the human administration API, not an agent tool.
   * @param id - saved connection with CREATE privilege.
   * @param name - new database name; an existing name fails without modification.
   * @param signal - caller cancellation.
   * @returns updated connection metadata.
   */
  async createDatabase(id: string, name: string, signal: AbortSignal): Promise<DatabaseConnection> {
    z.string()
      .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u)
      .parse(name)
    if (['mysql', 'sys', 'information_schema', 'performance_schema'].includes(name.toLowerCase()))
      throw new Error('System database names are reserved.')
    const saved = await this.saved(id)
    await this.execute(
      { action: 'mysql-create', url: saved.url, tls: saved.connection.tls, databaseName: name },
      signal,
    )
    const connection = { ...saved.connection, databases: [...new Set([...saved.connection.databases, name])] }
    await this.requireCredentials().modifyRecord(
      credentialKey(CONNECTION_NAMESPACE, `connection-${connection.id}`),
      (current) => {
        if (current?.kind !== 'grant') throw new Error('Connection was removed during database creation.')
        const stored = storedSchema.parse(current.payload)
        return Promise.resolve({
          kind: 'grant',
          payload: {
            ...stored,
            connection: {
              ...stored.connection,
              databases: [...new Set([...stored.connection.databases, name])],
            },
          },
        })
      },
    )
    return connection
  }
}
