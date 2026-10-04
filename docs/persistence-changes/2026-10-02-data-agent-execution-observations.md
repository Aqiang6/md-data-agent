---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-02-data-agent-execution-observations

English | [中文](2026-10-02-data-agent-execution-observations.zh.md)

## Summary

Adds optional Data Agent request observations, workflow phase/log progress records, and the calling tool identity on workflow run-start.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing events remain valid. The workflow callId field is optional; historical runs without it remain unlinked. New request and progress records carry ignorable=true, do not produce model messages, and can be skipped by older readers. Request snapshots remain external artifacts located by a digest and input-log cutoff; historical sessions without snapshots display unavailable details. The Session writer format remains unchanged.

<a id="verification"></a>
## Verification

Focused Vitest run covering Data Agent domain, Loader composition, evaluation extraction, workflow records and invariants, core Session, SDK server, and Data Agent UI: 13 files and 212 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
