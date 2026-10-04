---
description: "Data Agent 只读文件检索、SQL、Markdown 报告与评测提交。"
kind: "package-reference"
---

# @deepseek-ai/dsh-experimental-data-agent

[English](README.md) | 中文

## 概述

通过只读文件工具和 SQL 分析已配置的 SQLite／MySQL。人工 Markdown 的路径和内容版本进入已记录的系统提示词。SQL 返回预览与完整结果文件。报告工具生成 Markdown、HTML 或 PDF；评测模式增加 BIRD／Spider 的显式最终 SQL 提交。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与后续工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

<a id="use-this-package"></a>
## 使用本包

领域插件使用 commands、Session projections、Sessions、Session Query 和 LLM 服务提供 `dataAgent` 运行时，Web 服务可选。`./preset` 注册作用域内的 `./analysis` 能力、persona、只读文件检索、澄清和压缩。SQL、报告、数据源上下文和分析指引仅在该 preset 内生效，其他 preset 不会收到这些内容。Host 提供文件系统、文件检索所需 subprocess、用户问答与 token 计量。Web 和 SDK 选择同一 preset。

本包不依赖特定模型。`start.bat` 从 `dsh-data-agent.patch.yml` 准备可编辑的 `data-agent` profile；准备过程将配置的分析 preset 设为 profile 默认值，并迁移旧插件名，保留模型选择、领域配置、注释和 `!!js` 表达式。已保存连接与投影缓存保留存储标识。

用户和资料未定义指标且合理定义会改变结果时，指南要求先澄清并收到回答，再查询或计算该指标；已确认条件不重复提问。这是模型指引，SQL 执行不推断业务定义，也不强制检查是否已澄清。

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

| 工具 | 输入和输出 |
|---|---|
| `read` | `file_path`，可选行号 `offset`／`limit`；带行号文本 |
| `grep`／`find`／`ls` | 内容检索、文件名模式查找、目录直接子项 |
| `sql` | `sql`，可选 `database`、`params`、`timeoutMs`；`resultId`、`path`、`columns`、预览 `rows`、`rowCount`、`truncated`、`reading` |
| `report` | 完整 `markdown`、`title`、`formats`，可选 `language`；新修订及可下载 Markdown、HTML 或 PDF |
| `ask` | 问题及可选选项；用户回答 |
| `benchmark` | 仅评测：最终 `sql`、可选 `answer`；持久化预测供评分读取 |

文件相对路径以调用 Session 的 cwd 为准。Preset 不开放通用文件修改或脚本执行工具。`report` 接收内容，以生成的文件名写入 Session 存储并保留旧修订；调用方不能指定输出路径。修改报告时，读取返回的文档路径，再提交完整的新 Markdown。MySQL 部署应在强制只读事务之外使用只读账号。

SQL 支持单条只读语句、位置参数、CTE、关联、窗口函数和方言支持的元数据语句。SQLite 以只读方式打开并启用 `query_only`；MySQL 使用只读事务。拒绝可执行 SQL 注释、多语句和 SQL 文件写入。来源选择控制配置连接；每个生效库的所有表都出现在元数据中，并可通过 SQL 查询。超过安全整数范围的 SQLite 整数转为字符串，保留全部数字；重复结果列使用不同名称。

| 设置 | 默认值 | 含义 |
|---|---|---|
| `maxRows` | `50` | 预览行数；完整数据单独保存 |
| `maxResultRows`／`maxResultBytes` | `0`／`0` | 可选结果限制；零表示关闭，超过启用的限制会失败 |
| `queryTimeoutMs`／`cancellationGraceMs` | `0`／`5000` | 可选 worker 时限及取消确认间隔 |
| `maxSchemaBytes`／`maxKnowledgeDocuments` | `256000`／`100` | 每个来源及类别的当前上传字节数与数量 |

人工数据源管理器私有保存 MySQL 凭据。结构和业务 Markdown 共用按库管理的上传、版本、启用状态及逐项操作实现。每次请求发布所选库已提供且启用的资料，不连接数据库或生成结构 Markdown。内容变化在下一次请求时刷新，不可变目录版本保留早期文件。未提供结构资料时保持缺失。人工表浏览器独立读取实时元数据。

可选 `sources.json` 版本 2 将 Markdown 文件名及其 `schema` 或 `business` 类别绑定到完整数据源 ID。版本 1 映射仍可读取，作为按库名匹配的业务资料。配置资料可以停用，上传文档还可以替换或移除；两类文档执行相同的版本校验和内容限制。

```json
{"version":2,"sources":[{"database":"shop.db","documents":[{"filename":"schema.md","category":"schema"},{"filename":"metrics.md","category":"business"}]}]}
```

仅评测启用 preset 的 `benchmark: true`。评测器提取成功的 `benchmark` 结果，也识别历史 `finish` 和 `submit_analysis`；不以最后一次探查 SQL 替代提交。普通分析在聊天中回答，通过 `report` 交付文件。PDF 渲染需要可用的 Playwright Chromium 与字体。委派按需启用，需要 Host 提供子 Agent／workflow 依赖。

`/data_scope` 接收版本 2 的数据库选择，包括 `sources: [{ database }]` 和可为空的 `defaultDatabase`，拒绝表选项。历史版本 1 命令结果恢复数据库选择，忽略表清单，保留原日志。选择数据库后包含其当前所有表，也包含选择后新增的表。管理器的表刷新独立读取实时元数据，不修改资料存储。

<a id="understand-the-implementation"></a>
## 理解实现

[基础工具](src/primitives.ts) 在私有 provider scope 复用 Harness 文件和问答实现，仅发布读取和澄清工具。检索在分析作用域中直接注册 `grep` 与 `find`，包括完整结果 spill 处理器。[分析工具](src/analysis-tools.ts) 独立注册 SQL、报告和评测；[数据核心](src/data-core.ts) 管理来源选择、资料快照和结果文件。[Worker](src/query-worker.mjs) 将完整行流式写入 JSON，每行保存一条数据，内存仅保留预览。失败删除不完整文件，取消等待 worker 退出。

[报告](src/reports.ts) 发布带清单和摘要校验的不可变文件。[请求记录](src/trace.ts) 保存实际 Harness 请求，不添加模型消息；UI 阅读相同 Session 事件。资料锁、解析器、数据库权限与存储读取器分别执行自身规则，本包没有独立 invariant installer。参见[架构](../../../docs/architecture.zh.md)和 [SDK 场景](../../../snapshots/sdk/data-agent-tools/snapshot.yml)。官方数据集运行器和资源在此仓库之外维护。

<a id="model-experience"></a>
## 模型体验

### 系统提示词

#### 模型看到的内容

第一轮调用前可见生效数据库、库属文件清单、一个不可变目录路径和分析指南。指南要求模型在分析前逐一阅读已提供的全部结构和业务文档。提示词仅包含库属资料的目录。Preset 隐藏重复的通用文件和检索指南，以及已禁用工具的指引，工具仍保留参数说明。

##### 静态分析指南

```markdown
分析前用 read 逐一阅读当前库已提供的全部结构和业务资料。

用户和资料均未明确指标口径，且不同合理定义会影响结果时，必须用 ask 澄清并等待回答，再进行该指标的查询和计算。不得自行采用行业惯例、默认假设，或用事后说明代替确认。来源不明时也须澄清；已明确的条件不重复询问。

用 sql 只读查询。检查预览和总行数，完整数据按返回路径 read，不用预览推算总体。

结论保留业务名称，说明依据和限制；需要报告时向 report 提交完整 Markdown，修改时也提交全文。
```

#### Token 影响

来源引用的成本随启用的库属资料数量变化。一个目录摘要标识整组文件版本，不在提示词中重复各文件的版本哈希。加入明确澄清指引后，SDK fixture 的首轮系统提示词为 462 字符，加入规则前为 374 字符，简化前为 3,376 字符；Harness 密度算法粗估文本分别为 116、94 和 844 token，不含工具定义和已读取内容。完整资料延迟到读取时加载，直接引用避免一次发现调用。

#### KV Cache 影响

来源或资料选择改变已记录的提示词前缀。未变化的引用与指南文本可以复用。

### 工具定义与历史

#### 模型看到的内容

普通分析暴露七个工具；评测增加 benchmark。SQL 返回有限预览和完整文件路径；report 接收完整 Markdown 并返回不可变文件。领域工具定义见[工具目录](../../../docs/tool-catalog.zh.md#deepseek-aidsh-experimental-data-agent)。

#### Token 影响

一份保存的旧请求含 14 个工具、10,619 个定义字符；八工具评测 fixture 含 4,681 个字符。Harness 密度算法粗估为 2,659 与 1,175 token，不含随来源变化的提示词。预览和读取窗口限制保留数据。

#### KV Cache 影响

同一 preset 修订的工具定义稳定。调用与结果追加到 Session，直到正常压缩重建请求历史。

## 已知限制与后续工作

<a id="known-limitations-and-deferred-work"></a>

- 自定义统计和自动图表需要独立计算能力；本 preset 使用 SQL 计算。
- 报告数字需要计算复核。`benchmark` 记录预测，不执行或评分提交的 SQL。
- 云端 Spider2、DBT 项目提交及 BIRD-Interact 模拟器协议需要专门 provider。

<a id="dev-note"></a>
### 开发备注

无。
