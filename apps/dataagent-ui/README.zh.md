# Data Agent UI

[English](README.md) | 中文

基于 Harness Web 会话 API 的桌面分析工作台。瑞士风格布局将会话导航、分析结果和统一执行树分成独立列，最小宽度为 1,024 px。手机布局和手机测试不在范围内。

## 运行

使用 `pnpm --filter dataagent-ui build` 构建，运行 `pnpm exec tsx scripts/prepare-data-agent-profile.ts` 准备专用 profile，再运行 `pnpm dsh --profile data-agent --no-open`。`start.bat` 自动执行准备。初始化器仅从 `dsh-data-agent.patch.yml` 为一个空 profile 提供首次配置，保留后续设置；模型配置位于可编辑的 profile 用户层，不作为命令行 overlay。Vite 生成静态 bundle；认证、会话 API、工具与请求产物仅由 `dsh` profile 提供。全新 profile 仅提供官方 DeepSeek 模型，默认选择 DeepSeek Flash，不预置个人数据库连接或业务文档。通过凭据存储配置 DEEPSEEK_API_KEY，或从 .env.example 复制本地 .env；不要提交凭据。

## 分析记录

历史列表和自动恢复仅包含记录的 preset 为 `data-agent` 的根会话。编程会话及未确认分析 preset 的会话不显示；列表缺少提示信息时，从 Session projections 解析，无须激活 Agent。每条记录有独立删除按钮和内联确认，可通过 Escape 或点击外部取消。删除复用 Harness Workspace 归档操作，持久地从列表移除记录，保留日志与报告文件。Host 拒绝仍有活动的会话；失败时保留记录和确认区。删除当前项切换到下一条可见记录，删除最后一项显示空状态。Workspace follow 的基线与归档更新让多个窗口及重启后的列表保持同步，不依赖浏览器本地删除标记。

构建后运行 `node apps/dataagent-ui/tests/analysis-history.web.mjs --live`，检查真实 GLM 活动保护、确认删除、失败保留、多窗口更新、重启恢复及四种桌面宽度。测试隔离 home，仅操作新建的测试记录，不使用用户分析。

## 模型与 API

输入区分别显示最近实际请求使用的模型与下次请求选择的模型，均读取原 Harness 的 `modelSelection` 投影；切换使用 `session/selectModel` 和已有持久事件。运行中的请求保留记录的模型。切换影响后续请求，并由 Harness 保存为新分析的默认值；历史会话保留自己的选择。只有该模型明确声明时才显示推理强度选项。供应商目录在修改、窗口恢复焦点及定期刷新时更新，读取失败保持可见。

侧栏“模型与 API”页面复用 `llm-pi-ai`、模型发现、带版本检查的设置修改与只写凭据服务。自定义接入支持 OpenAI Chat Completions、OpenAI Responses、Anthropic Messages，可填写 Base URL、可选密钥、模型 ID、名称、Token 上限与图像能力。发现模型后需显式勾选候选，也能手动填写 ID。保存接入不会切换模型。表单没有暴露的兼容开关、headers 等字段保持不变。API Key 提交 Host 凭据存储前只留在表单内存中，不进入设置读取或 Session 轨迹。凭据写入失败仅重试凭据；配置版本冲突需重新打开编辑器。移除用户创建的接入保留凭据，不能移除运行配置自带的供应商。Home patch 和命令行覆盖仍有更高优先级，可能拒绝设置页修改。

构建后运行 `node apps/dataagent-ui/tests/models.web.mjs`，执行无密钥的真实 profile 浏览器检查；附加 `--live` 会使用本机配置的密钥调用官方 DeepSeek。每次运行隔离 home，使用回环测试供应商，在 `.playwright-mcp` 保存桌面截图、视频与轨迹。

## 执行与结果

执行面板折叠持久化 Session 事件，订阅新事件，并按序号补齐缺口。workflow 运行记录的 `callId` 定位其工具节点；展开成员后订阅实际子会话。缺少该标识的历史运行独立展示。请求详情读取不可变的 harness 快照，不代表供应商 HTTP 内部数据或隐藏思考。提示词、上下文、可用工具、请求信息和原文选中后直接加载全文，无需翻页或展开操作。工具清单在未改动的原始定义上方逐项显示本地化用途，未知工具显示请求记录中的描述；所有分区支持整节下载和全宽视图。JSON 使用单一滚动区，不受嵌套代码块高度限制；Markdown 视图不加载提示词示例中的图片。过期响应不会覆盖当前选中的其他分区。普通分析不加载多 Agent 编排；可通过[预设配置](../../packages/experimental/data-agent/README.zh.md#use-this-package)显式启用，不改变历史执行树。

查询表格区分预览与完整结果。报告链接使用已认证的产物接口，HTML 预览使用沙箱 iframe。澄清答案进入普通工具结果日志。数据源工作区连接 MySQL，为每次分析选择生效数据库和默认库。生效库的所有表均可查询，表清单仅供查看和筛选，没有启停控件。“Schema 知识库”和“业务知识库”共用多个 MD 的管理方式：筛选、逐项阅读下载、启停、带版本校验的替换和确认移除。配置资料可以停用，上传文件还可以替换或移除。表刷新读取实时元数据，不创建文档。连接密码提交凭据存储前仅留在表单内存中，公开目录响应不含密码或私有 URL。权限、新建库、范围与上传语义见 [领域插件](../../packages/experimental/data-agent/README.zh.md#use-this-package)。

没有分析时，从主页列表或顶部下拉框选择数据源会自动新建一条分析，并将所选来源保存为默认数据库。“数据源管理”也会自动创建缺少的分析。创建期间禁用这些入口和“新建分析”按钮，避免重复创建；失败后可通过原入口重试。已有分析时直接将选择应用到当前分析。

回答完成后提供报告格式选择（Markdown、HTML 或 PDF）和“生成报告”。只有点击后才通过普通日志化 follow-up 为选中的分析轮次请求报告，不清除输入框草稿。分析运行时禁用这些控件，发送失败保留答案和格式供重试。回答末尾的证据段只在展示中隐藏，历史回答也生效；原 Session 事件与执行详情保持不变。正文内引用、代码示例及后续回答章节仍可见。

默认分析预设通过数据库 SQL 计算，不提供文件导入、查询后算子或独立图表工具，详见[领域配置](../../packages/experimental/data-agent/README.zh.md#use-this-package)。历史调用仍可阅读，前端查询图表保留。数据文件上传与报告编辑尚无专门视图。根目录 .gitignore 排除本地数据库、业务文档、基准测试文件和浏览器产物；官方基准测试在此工程之外维护。

构建后运行 `node apps/dataagent-ui/tests/knowledge.web.mjs --live`，检查空主页选择数据源、创建失败后重试、多文件添加、逐项操作、刷新恢复、票务资料发现、认证下载及四种桌面宽度，并核验真实 GLM 阅读文档。运行隔离 profile 与证据存储，不修改业务数据。
