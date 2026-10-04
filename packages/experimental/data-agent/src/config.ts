/**
 * Data Agent reading, computation, evidence, and optional Web configuration.
 * @module @deepseek-ai/dsh-experimental-data-agent/config
 */
import z from '@deepseek-ai/schemastery'

/** Deployment settings shared by Web, SDK, and evaluation tools. */
export interface Config {
  /**
   * Directory scanned for SQLite files; a relative path resolves against the
   * process cwd. The scan seeds the source picker and `glmDb` projection.
   */
  directory: string
  /** Maximum rows in a query preview; complete results use separate limits. */
  maxRows: number
  /**
   * MySQL schema names exposed alongside the SQLite files, selectable in the
   * picker and queryable through `sql`.
   */
  mysqlDatabases: string[]
  /**
   * Name of the environment variable holding the MySQL connection URL
   * (`mysql://user:pass@host:port`), resolved from the launch environment or
   * `.env`; the value never enters the configuration file.
   */
  mysqlUrlEnv: string
  /**
   * Directory of the built data-agent React app served on the web surface:
   * the index replaces the workbench index through a webserver index tap, and
   * assets ride the `/da-assets` prefix. A relative path resolves against the
   * process cwd; an empty string disables UI serving.
   */
  uiDist: string
  /** Session evidence directory, independent of the Web carrier. */
  artifactsDirectory: string
  /** Markdown documents and optional sources.json mapping database names to business references. */
  documentsDirectory: string
  /** Complete-result row limit; zero disables it. */
  maxResultRows: number
  /** Serialized-result, import and trace-export byte limit; zero disables it. */
  maxResultBytes: number
  /** Worker lifetime including connection and execution; zero disables it. */
  queryTimeoutMs: number
  /** Time allowed for a worker to acknowledge cancellation before forced termination. */
  cancellationGraceMs: number
  /** Maximum characters in one Markdown page. */
  documentPageChars: number
  /** Maximum rows in one rendered chart. */
  maxChartPoints: number
  /** Optional Chromium executable for PDF rendering; empty uses Playwright's installation. */
  browserExecutablePath: string
  /** Maximum UTF-8 bytes in all current uploads per category and complete active business knowledge. */
  maxSchemaBytes: number
  /** Maximum current uploaded documents per source and knowledge category. */
  maxKnowledgeDocuments: number
  /** Maximum wait for the cross-process knowledge writer lock. */
  documentWriteTimeoutMs: number
}

/** Validated Data Agent deployment settings. */
export const Config: z<Config> = z.object({
  directory: z.string().default('databases'),
  maxRows: z.number().step(1).min(1).max(10_000).default(50),
  mysqlDatabases: z.array(z.string()).default([]),
  mysqlUrlEnv: z.string().default('MYSQL_URL'),
  uiDist: z.string().default('apps/dataagent-ui/dist'),
  artifactsDirectory: z.string().default('.data-agent'),
  documentsDirectory: z.string().default('data-agent-docs'),
  maxResultRows: z.number().step(1).min(0).default(0),
  maxResultBytes: z.number().step(1).min(0).default(0),
  queryTimeoutMs: z.number().step(1).min(0).max(2_147_483_647).default(0),
  cancellationGraceMs: z.number().step(1).min(1).max(60_000).default(5000),
  documentPageChars: z.number().step(1).min(256).max(100_000).default(12_000),
  maxChartPoints: z.number().step(1).min(1).max(1000).default(100),
  browserExecutablePath: z.string().default(''),
  maxSchemaBytes: z.number().step(1).min(1024).max(10_000_000).default(256_000),
  maxKnowledgeDocuments: z.number().step(1).min(1).max(1000).default(100),
  documentWriteTimeoutMs: z.number().step(1).min(1).max(60_000).default(5000),
})
