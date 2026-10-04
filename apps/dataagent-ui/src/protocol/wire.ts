/**
 * Wire types for the dsh client protocol surfaces the data agent consumes:
 * the journal event envelope, session summaries, and follow/page frames.
 */

/** One durable session-log event on the client wire. */
export interface WireEvent {
  readonly type: string
  readonly seq: number
  readonly time: number
  readonly data: Record<string, unknown>
  readonly ignorable?: true
}

/** One history-page record (always a raw event on this surface). */
export type HistoryRecord = { readonly type: 'event'; readonly event: WireEvent }

/** Session summary as returned by `session/list`. */
export interface SessionSummary {
  readonly sessionId: string
  readonly updatedAt: number
  readonly running: boolean
  readonly blank: boolean
  readonly cwd?: string
  readonly origin?: string
  readonly parentSessionId?: string
  readonly projections?: {
    readonly values: { readonly agentPreset?: string | null }
  }
}

/** The follow-stream opening snapshot. */
export interface FollowSnapshot {
  readonly type: 'snapshot'
  readonly cursor: number
  readonly records: readonly HistoryRecord[]
  readonly hasMore: boolean
}

/** Follow-stream items after the snapshot. */
export type FollowItem = { readonly type: 'event'; readonly event: WireEvent } | FollowSnapshot

/** `content` block of a model message (text/reasoning/tool-call are all we render). */
export interface ContentBlockLike {
  readonly type: string
  readonly text?: string
  readonly id?: string
  readonly name?: string
  readonly arguments?: string
}

/** Extract the text of every block with one of the given types. */
export function blocksText(content: unknown, types: readonly string[]): string {
  if (typeof content === 'object' && content !== null && 'content' in content) return blocksText(content.content, types)
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    const b = block as ContentBlockLike
    if (types.includes(b.type) && typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('')
}

/** Extract tool-call blocks from a message content array. */
export function blocksToolCalls(content: unknown): Array<{ id: string; name: string; arguments: string }> {
  if (!Array.isArray(content)) return []
  const out: Array<{ id: string; name: string; arguments: string }> = []
  for (const block of content) {
    const b = block as ContentBlockLike
    if (b.type === 'tool-call' && typeof b.id === 'string' && typeof b.name === 'string') {
      out.push({ id: b.id, name: b.name, arguments: typeof b.arguments === 'string' ? b.arguments : '' })
    }
  }
  return out
}

/** One text content block. */
export function textBlock(text: string): { type: 'text'; text: string } {
  return { type: 'text', text }
}
