/**
 * Data Agent database discovery and read-only statement screening for SQLite
 * files and configured MySQL schemas.
 * @module @deepseek-ai/dsh-experimental-data-agent/databases
 */

import { readdirSync } from 'node:fs'
import { isAbsolute, join, resolve } from 'node:path'
import type { Config } from './config.ts'

/** File extensions treated as SQLite databases. */
const DATABASE_EXTENSIONS = new Set(['.db', '.sqlite', '.sqlite3'])

/** Statement heads a read-only SQLite query may start with. */
export const SQLITE_READ_HEADS: ReadonlySet<string> = new Set(['select', 'with', 'explain', 'pragma'])

/** Statement heads a read-only MySQL query may start with. */
export const MYSQL_READ_HEADS: ReadonlySet<string> = new Set(['select', 'with', 'show', 'describe', 'desc', 'explain'])

/** Recognize a plain SQLite basename without traversal.
 * @param name - candidate source name.
 * @returns whether the name has a supported SQLite extension and no separators.
 */
export function isSqliteDatabaseName(name: string): boolean {
  if (name.includes('/') || name.includes('\\') || name === '.' || name === '..') return false
  const dot = name.lastIndexOf('.')
  return dot > 0 && DATABASE_EXTENSIONS.has(name.slice(dot).toLowerCase())
}

/**
 * List every database the deployment exposes: SQLite file basenames from the
 * configured directory plus the configured MySQL schema names, ascending.
 * @param config - the plugin configuration carrying the directory and MySQL schemas.
 * @returns available database names, ascending.
 */
export function listDatabases(config: Pick<Config, 'directory' | 'mysqlDatabases'>): string[] {
  let sqliteNames: string[]
  try {
    sqliteNames = scanDatabases(config.directory)
  } catch {
    sqliteNames = []
  }
  return [...new Set([...sqliteNames, ...config.mysqlDatabases])].sort()
}

/**
 * Scan `directory` for SQLite database files.
 * @param directory - configured directory; a relative path resolves against the process cwd.
 * @returns available database basenames, ascending.
 */
export function scanDatabases(directory: string): string[] {
  const root = isAbsolute(directory) ? directory : resolve(process.cwd(), directory)
  return readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isFile() && isSqliteDatabaseName(entry.name))
    .map(entry => entry.name)
    .sort()
}

/**
 * Resolve a configured or user-named SQLite database to an absolute path
 * inside the configured directory. A name never escapes the directory:
 * separators, traversal segments, and missing extensions fail the resolution.
 * @param directory - configured database directory.
 * @param name - database basename chosen by the model or the `/db` command.
 * @returns the absolute file path.
 * @throws when the name is not a plain SQLite basename.
 */
export function resolveDatabasePath(directory: string, name: string): string {
  const root = isAbsolute(directory) ? directory : resolve(process.cwd(), directory)
  if (!isSqliteDatabaseName(name)) {
    throw new Error(`data-agent: "${name}" is not a SQLite database file name in the configured directory`)
  }
  return join(root, name)
}

/**
 * Screen one read-only statement: a single statement whose head is a read
 * head of the target dialect.
 * @param sql - the model-supplied SQL text.
 * @param heads - the read-statement heads of the target dialect.
 * @returns the trimmed statement with one optional trailing semicolon removed.
 * @throws when the statement is empty, carries a second statement, or is not a read.
 */
export function screenReadStatement(sql: string, heads: ReadonlySet<string>): string {
  const statement = sql.trim().replace(/;\s*$/u, '')
  if (statement.length === 0) throw new Error('data-agent: the SQL statement is empty')
  if (statement.includes(';')) {
    throw new Error('data-agent: exactly one SQL statement is allowed per query (remove the extra semicolon)')
  }
  const head = /^([a-zA-Z]+)/u.exec(statement)?.[1]?.toLowerCase() ?? ''
  if (!heads.has(head)) {
    throw new Error('data-agent: only read statements are allowed, got '
      + `"${head}" (allowed: ${[...heads].map(name => name.toUpperCase()).join(' / ')})`)
  }
  return statement
}
