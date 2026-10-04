# MD Data Agent

[English](README.md) | 中文

基于 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 和 Cordis 的数据库分析助手。通过统一的文件工具阅读 Schema 和业务 Markdown，澄清模糊指标，执行 SQL，并保留可查看的提示词、工具调用和结果轨迹。

<a id="run"></a>

<a id="run-from-source"></a>

## 运行

安装 Node.js `^22.19.0 || >=24.0.0` 和 pnpm `11.7.0`。Windows 下运行 `start.bat`，安装依赖、构建缺少的产物并启动专用 Data Agent profile。也可显式执行源码启动流程：

```sh
pnpm install
pnpm run build
pnpm --filter dataagent-ui run build
pnpm exec tsx scripts/prepare-data-agent-profile.ts
pnpm dsh --profile data-agent
```

初始 profile 提供官方 DeepSeek 模型，默认选择 DeepSeek Flash。在“模型与 API”中配置自己的密钥，或将 `.env.example` 复制为 `.env` 后填写 `DEEPSEEK_API_KEY`。后续准备 profile 时保留已选择的模型。

通过数据源管理连接自己的数据库，并提供对应的 Schema 和业务 Markdown。仓库不包含个人连接、数据库、业务资料或 API Key。工作台用法见 [Data Agent UI](apps/dataagent-ui/README.zh.md)，数据源权限和文档绑定见 [Data Agent 配置](packages/experimental/data-agent/README.zh.md)。

## 仓库内容

可运行的 Harness 工作区、Cordis 源码、构建脚本和回归测试资料共同保留。本地凭据、数据库、业务文档、构建产物、浏览器录制和基准测试运行记录均被忽略。官方 BIRD 和 Spider 基准测试资源及运行结果在此工程之外单独维护。

提交前运行 `pnpm run check:git-files`。提交钩子会拒绝被强行加入 Git 暂存区的忽略文件；这项检查不扫描早期 Git 历史，也不判断任意源码文本中是否存在密钥。

## 开发

从[架构](docs/architecture.zh.md)、[开发指南](docs/development.zh.md)和 [AGENTS.md](AGENTS.md)开始。本仓库扩展 DeepSeek Harness，上游框架源码保留原包名和许可证。

## 许可证

[MIT](LICENSE)。依赖许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
