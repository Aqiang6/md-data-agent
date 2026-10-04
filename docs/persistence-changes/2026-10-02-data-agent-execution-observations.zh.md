---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-02-data-agent-execution-observations

[English](2026-10-02-data-agent-execution-observations.md) | 中文

## 概述

增加可忽略的 Data Agent 请求观测、workflow 阶段与日志进度记录，以及 workflow 开始记录中的调用工具标识。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-02-data-agent-execution-observations
baseline: false
changes:
  - root: "event:data-agent/request"
    previous: null
    after: "622f940fe36d3cd4f9ce377478111088b159c987d58e41bd8886153d3eae5986"
    decision: same-version
  - root: "event:data-agent/request-end"
    previous: null
    after: "1451d96ca792749c1ea9e711ca6c205ae87f5c06a68aca887d720120a0e51778"
    decision: same-version
  - root: "event:tool-workflow/log"
    previous: null
    after: "d1a76ca217758d3ffe98fa1a5edbe84d754b66228cd9436ef2fd8c4de38e1886"
    decision: same-version
  - root: "event:tool-workflow/phase"
    previous: null
    after: "49d14928d15c22e1caaab450eb5e0df37bd0165d0c2d460cbff8cdea371aa28b"
    decision: same-version
  - root: "event:tool-workflow/run-start"
    previous: "2026-09-11-initial"
    after: "fa979c353d6662370278ebad515bd45254413c2a7c60618d9f4f0413ac2ef42c"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有事件保持有效。workflow callId 字段可选，缺少该字段的历史运行保持独立展示。新的请求与进度记录携带 ignorable=true，不生成模型消息，旧读取方可以跳过。请求快照是外部产物，由摘要和输入日志截止位置定位；缺少快照的历史会话显示详情不可用。Session 写入格式保持不变。

<a id="verification"></a>
## 验证

执行覆盖 Data Agent 领域、Loader 组合、评测提取、workflow 记录与 invariant、核心 Session、SDK server 及 Data Agent UI 的聚焦 Vitest：13 个文件、212 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
