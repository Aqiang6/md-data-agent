/** Authenticated human data-source configuration, separate from model tools. */
import { t } from '../copy.ts'
/** Public source identity; credentials never enter this response. */
export interface SourceInfo {
  id: string
  name: string
  kind: 'sqlite' | 'mysql'
  connectionId?: string
  connectionLabel?: string
}
/** Safe connection metadata returned after saving or creation. */
export interface DatabaseConnection {
  id: string
  label: string
  host: string
  port: number
  username: string
  tls: boolean
  databases: string[]
  credentialEnv?: string
}
/** Explicit session-enabled databases; every table in an enabled database is available. */
export interface DataScope {
  version: 2
  sources: Array<{ database: string }>
  defaultDatabase: string | null
}
/** Live fields for the human table browser, without document generation. */
export interface DatabaseMetadata {
  database: string
  tables: Array<{ name: string; columns: Array<{ name: string }> }>
}
/** Structure or business Markdown with separate configured and uploaded versions. */
export interface SourceKnowledge {
  database: string
  markdown: string
  documents: KnowledgeDocument[]
  references: Array<{ filename: string; version: string }>
}
/** Source-scoped configured or uploaded Markdown. */
export interface KnowledgeDocument {
  id: string
  filename: string
  version: string
  uploadedAt: string | null
  origin: 'configured' | 'uploaded'
  enabled: boolean
  markdown: string
}
/** Full source catalog for the human manager. */
export interface SourceCatalog {
  sources: SourceInfo[]
  connections: DatabaseConnection[]
  databases: string[]
}
/** Read a source-management response and retain server validation errors.
 * @param path - configuration route relative to /api/data-agent/.
 * @param body - optional human-only form payload.
 * @returns decoded response.
 */
export async function sourceRequest<T>(path: string, body?: object): Promise<T> {
  const response = await fetch(
    `/api/data-agent/${path}`,
    body
      ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : undefined,
  )
  if (response.status === 401) throw new Error(t('notLoggedIn'))
  const value = (await response.json()) as T & { error?: string }
  if (!response.ok) throw new Error(value.error ?? t('sourceOperationFailed'))
  return value
}
