/** Decode the existing Workspace archive feed for analysis-history visibility. */
import type { SessionSummary } from '../protocol/wire.ts'

/**
 * Read archive identities from a baseline or archive update; ignore other Workspace changes.
 * @param value - Workspace follow item received over the mux.
 * @returns Validated archive identities, or undefined for unrelated updates.
 */
export function archiveIds(value: unknown): string[] | undefined {
  if (typeof value !== 'object' || value === null || !('type' in value)) throw new Error('Invalid Workspace frame')
  const record = value.type === 'baseline' && 'value' in value ? value.value : value
  if (value.type !== 'baseline' && value.type !== 'archived') return undefined
  if (typeof record !== 'object' || record === null || !('archivedSessionIds' in record))
    throw new Error('Missing Workspace archive identities')
  const ids = record.archivedSessionIds
  if (!Array.isArray(ids) || !ids.every((id: unknown) => typeof id === 'string'))
    throw new Error('Invalid Workspace archive identities')
  return ids
}

/**
 * Filter analysis records using the durable archive set, never local browser storage.
 * @param sessions - Complete Host session list.
 * @param archived - Archive identities; undefined while the baseline is pending.
 * @returns Unarchived data-agent roots in their original order; other presets remain excluded.
 */
export function analysisHistory(sessions: readonly SessionSummary[], archived: readonly string[] | undefined): SessionSummary[] {
  if (!archived) return []
  const hidden = new Set(archived)
  return sessions.filter(session => session.projections?.values.agentPreset === 'data-agent'
    && session.parentSessionId === undefined && !hidden.has(session.sessionId))
}
