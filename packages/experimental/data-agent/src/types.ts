/**
 * Shared Data Agent projection types: the `glmDb`
 * session projection folded from `/db` command records, merged into the
 * projection maps consumed by both the Host registration and the browser dock.
 * @module @deepseek-ai/dsh-experimental-data-agent/types
 */
import type { Context } from '@deepseek-ai/cordis'

/** Host capabilities used by the scoped analysis composition. */
export interface DataAgentRuntime {
  /** Register SQL, reports and optional evaluation submission in an analysis scope.
   * @param ctx - Scoped tool owner; global installation is rejected.
   * @param benchmark - Expose final SQL submission for evaluation.
   */
  installTools(ctx: Context, benchmark: boolean): void
  /** Publish current source-owned structure and business file references.
   * @param sessionId - Analysis session whose selection determines the sources.
   * @param signal - Current request cancellation.
   * @returns Compact source and document directory for the logged system prompt.
   */
  analysisContext(sessionId: string, signal?: AbortSignal): Promise<string>
}

/**
 * One `glmDb` projection snapshot. `databases` lists the SQLite file basenames
 * found in the configured directory at registration (and refreshed on every
 * `/db` fold); `selected` names the database the session's latest `/db`
 * command picked, or `null` before the first selection.
 */
export interface DataAgentProjection {
  /** Available database file basenames, ascending. */
  readonly databases: readonly string[]
  /** Current `/db` selection, or `null` before the first selection. */
  readonly selected: string | null
}

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionMap {
    /**
     * Data Agent database picker state: the available SQLite files plus the
     * session's current `/db` selection. Folded from `command/run` records of
     * the `db` command, so the dock survives session reload. The registered key
     * retains its historical spelling for persisted projection caches.
     */
    glmDb: DataAgentProjection
  }
}
