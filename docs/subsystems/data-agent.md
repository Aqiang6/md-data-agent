# Data Agent

English | [中文](data-agent.zh.md)

The experimental [Data Agent package](../../packages/experimental/data-agent/README.md) owns read-only SQLite/MySQL analysis, manual source knowledge and report artifacts. Its Host plugin provides `ctx.dataAgent`; the analysis preset installs model tools and source guidance in its standing scope.

## Scope and restoration

SQL, reports and the source reading list belong to the analysis preset. Ordinary analysis exposes seven tools; evaluation explicitly adds `benchmark`. Other presets receive no analysis tools or prompt sections. Session preset projections determine restoration and the Data Agent UI history; unknown or coding presets are excluded from that UI.

The runtime publishes current file references for the requesting session, and the normal request snapshot records the resulting model-visible context. Database credentials remain in the Host connection catalog. The [package reference](../../packages/experimental/data-agent/README.md) owns deployment settings, tool inputs and storage details.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxdataagent--dataagentruntime"></a>

### `ctx.dataAgent` — `DataAgentRuntime`

Host capabilities used by the scoped analysis composition.

```ts cordis-catalog
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
```

Source: [`packages/experimental/data-agent/src/types.ts`](../../packages/experimental/data-agent/src/types.ts)
<!-- END GENERATED cordis-surface -->
