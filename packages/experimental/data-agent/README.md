---
description: "Data Agent read-only file discovery, SQL, Markdown reports and benchmark submissions."
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-data-agent

English | [中文](README.zh.md)

## Summary

Analyze configured SQLite/MySQL sources through read-only file tools and SQL. Human-authored Markdown paths and content versions enter the logged system prompt. SQL returns a preview and complete result file. The report tool writes Markdown, HTML or PDF; evaluation mode adds explicit final SQL submission for BIRD/Spider.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

The domain plugin provides the `dataAgent` runtime using commands, Session projections, Sessions, Session Query and LLM services; Web services are optional. `./preset` registers the scoped `./analysis` capabilities, persona, read-only file discovery, clarification and compaction. SQL, reports, source context and analysis instructions are available only within that preset; other presets receive none of them. The Host supplies filesystem, subprocess for file search, user questions and token metering. Web and SDK select the same preset.

The package is model-independent. `start.bat` prepares the editable `data-agent` profile from `dsh-data-agent.patch.yml`; preparation selects the configured analysis preset as the profile default and migrates previous plugin names while preserving model choices, domain settings, comments and `!!js` expressions. Saved connections and projection caches retain their storage identifiers.

When users and documents leave a metric undefined and reasonable definitions change its result, the guide requires clarification and a reply before that metric's query or calculation. Confirmed conditions need no repeated questions. This is model guidance; SQL execution does not infer business definitions or enforce a clarification gate.

```yaml
- name: '@deepseek-ai/dsh-experimental-data-agent'
  config:
    directory: databases
    documentsDirectory: data-agent-docs
    artifactsDirectory: .data-agent
- name: '@deepseek-ai/dsh-experimental-data-agent/preset'
  config:
    benchmark: false
```

| Tool | Input and output |
|---|---|
| `read` | `file_path`, optional line `offset`/`limit`; line-numbered text |
| `grep` / `find` / `ls` | Content search, filename patterns, immediate directory entries |
| `sql` | `sql`, optional `database`, `params`, `timeoutMs`; `resultId`, `path`, `columns`, preview `rows`, `rowCount`, `truncated`, `reading` |
| `report` | Complete `markdown`, `title`, `formats`, optional `language`; a new revision with downloadable Markdown, HTML or PDF |
| `ask` | Questions and optional choices; human answers |
| `benchmark` | Evaluation only: final `sql`, optional `answer`; persisted prediction for scoring |

Relative file paths use the calling Session's cwd. The preset exposes no general file mutation or script execution tools. `report` accepts content, writes generated filenames under Session storage and preserves previous revisions; callers cannot choose an output path. To revise a report, read its returned document path and submit the complete updated Markdown. MySQL deployments should use a read-only account alongside the enforced read-only transaction.

SQL permits one read-only statement, positional parameters, CTEs, joins, windows and dialect-supported metadata statements. SQLite opens read-only and enables `query_only`; MySQL uses a read-only transaction. Executable SQL comments, multiple statements and SQL file writes are rejected. Source selection controls configured connections; all tables in each enabled database appear in metadata and are available to SQL. Unsafe-size SQLite integers become strings without losing digits; duplicate result columns receive distinct names.

| Setting | Default | Meaning |
|---|---|---|
| `maxRows` | `50` | Preview rows; complete data is saved separately |
| `maxResultRows` / `maxResultBytes` | `0` / `0` | Optional result limits; zero disables them, exceeding an enabled limit fails |
| `queryTimeoutMs` / `cancellationGraceMs` | `0` / `5000` | Optional worker deadline and cancellation acknowledgement interval |
| `maxSchemaBytes` / `maxKnowledgeDocuments` | `256000` / `100` | Current upload bytes and count per source/category |

The human source manager stores MySQL credentials privately. Structure and business Markdown use the same source-scoped upload, version, enablement and item-management implementation. Each request publishes the enabled documents supplied for its selected sources without connecting to a database or generating schema Markdown. Content changes refresh on the next request; immutable directory versions preserve earlier files. Missing structure documents remain absent. The human table browser retrieves live metadata separately.

Optional `sources.json` version 2 binds Markdown basenames and their `schema` or `business` category to exact source IDs. Version 1 mappings remain readable as business references matched by database name. Configured references can be disabled; uploaded documents can also be replaced or removed. Both categories enforce the same version checks and content limits.

```json
{"version":2,"sources":[{"database":"shop.db","documents":[{"filename":"schema.md","category":"schema"},{"filename":"metrics.md","category":"business"}]}]}
```

Enable preset `benchmark: true` only for evaluation. The evaluator extracts successful `benchmark` results, also recognizing historical `finish` and `submit_analysis`; it never substitutes the last exploratory SQL. Ordinary analysis answers in chat and delivers files through `report`. PDF rendering requires available Playwright Chromium and fonts. Delegation is opt-in and requires Host subagent/workflow providers.

`/data_scope` accepts version 2 database selections with `sources: [{ database }]` and a nullable `defaultDatabase`; table options are rejected. Historical version 1 command results restore database choices and discard their table lists without rewriting the log. Selecting a database includes its current tables, including tables added after the selection. The manager's table refresh retrieves live metadata independently of document storage.

<a id="understand-the-implementation"></a>
## Understand the implementation

[Primitives](src/primitives.ts) reuse Harness file and question implementations in a private provider scope and publish only read/clarification tools. Search registers `grep` and `find` directly in the analysis scope, including their complete-result spill handlers. [Analysis tools](src/analysis-tools.ts) register independent SQL, report and benchmark operations; [data core](src/data-core.ts) owns source selection, knowledge snapshots and result files. [The worker](src/query-worker.mjs) streams complete rows to JSON with one row per line while retaining only the preview. Errors remove partial files, and cancellation waits for worker shutdown.

[Reports](src/reports.ts) publish immutable files with manifest and digest checks. [Request recording](src/trace.ts) saves actual Harness requests without adding model messages; the UI reads the same Session events. Knowledge locks, parsers, database permissions and storage readers enforce their owned relationships; there is no separate package invariant installer. See the [architecture](../../../docs/architecture.md) and [SDK scenario](../../../snapshots/sdk/data-agent-tools/snapshot.yml). Official dataset runners and resources are maintained outside this repository.

<a id="model-experience"></a>
## Model Experience

### System prompt

#### What the model sees

Selected databases, source-owned file lists, one immutable directory path and the analysis guide appear before the first call. The guide asks the model to read every supplied structure and business document before analysis. The prompt includes only the source-owned document directory. The preset suppresses duplicate generic file/search guidance and instructions for disabled tools; the tools retain their parameter documentation.

##### Static analysis guide

```markdown
分析前用 read 逐一阅读当前库已提供的全部结构和业务资料。

用户和资料均未明确指标口径，且不同合理定义会影响结果时，必须用 ask 澄清并等待回答，再进行该指标的查询和计算。不得自行采用行业惯例、默认假设，或用事后说明代替确认。来源不明时也须澄清；已明确的条件不重复询问。

用 sql 只读查询。检查预览和总行数，完整数据按返回路径 read，不用预览推算总体。

结论保留业务名称，说明依据和限制；需要报告时向 report 提交完整 Markdown，修改时也提交全文。
```

#### Token effect

Source references cost tokens according to the number of enabled source-owned documents. One directory digest identifies the complete file version; individual version hashes are not repeated in the prompt. The SDK fixture's first system prompt has 462 characters with explicit clarification guidance, compared with 374 before that rule and 3,376 before simplification: about 116, 94 and 844 text tokens under the Harness density heuristic, excluding tool definitions and retrieved content. Full knowledge remains deferred until read, and direct references avoid a discovery call.

#### KV Cache effect

Source or document selection changes the logged prompt prefix. Unchanged references and guide text remain reusable.

### Tool schemas and history

#### What the model sees

Ordinary analysis exposes seven tools; evaluation adds benchmark. SQL returns bounded previews and complete file paths; report accepts full Markdown and returns immutable files. Domain definitions appear in the [tool catalog](../../../docs/tool-catalog.md#deepseek-aidsh-experimental-data-agent).

#### Token effect

A saved 14-tool request had 10,619 schema characters; the eight-tool evaluation fixture has 4,681. The Harness density heuristic estimates 2,659 versus 1,175 tokens, excluding source-dependent prompt text. Previews and read windows bound retained data.

#### KV Cache effect

Schemas stay stable for a preset revision. Calls/results append to the Session until ordinary compaction rebuilds the request history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Custom statistics and automated chart generation need a separate calculation capability; this preset calculates with SQL.
- Report numbers need calculation review. `benchmark` records a prediction; it neither executes nor scores submitted SQL.
- Cloud Spider2, DBT project submissions and BIRD-Interact simulator protocols need dedicated providers.

<a id="dev-note"></a>
### Dev Note

None.
