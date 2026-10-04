# Data Agent

[English](data-agent.md) | 中文

实验性的 [Data Agent 包](../../packages/experimental/data-agent/README.zh.md) 负责 SQLite/MySQL 只读分析、人工数据源资料和报告产物。Host 插件提供 `ctx.dataAgent`；分析 preset 在其 standing scope 内安装模型工具和数据源指引。

## 作用域与恢复

SQL、报告和数据源阅读列表属于分析 preset。普通分析提供七个工具；评测显式增加 `benchmark`。其他 preset 不会收到分析工具或提示词段落。Session preset projections 决定恢复行为与 Data Agent UI 历史列表；未知或编程 preset 不显示在该 UI 中。

运行时为请求所属会话发布当前文件引用，常规请求快照记录最终面向模型的上下文。数据库凭据保留在 Host 连接目录中。[包参考](../../packages/experimental/data-agent/README.zh.md) 负责部署配置、工具输入和存储细节。

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.zh.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

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
