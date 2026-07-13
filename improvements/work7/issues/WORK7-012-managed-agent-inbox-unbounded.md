---
title: "[AUDIT/V7] Managed-agent inbox/results files grow unbounded and are fully rewritten per message (O(n²) delivery)"
labels: ["bug", "audit-finding-v7", "medium", "reliability"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-012"
severity: "medium"
category: "reliability"
github-issue: ""
---

## Problem Description

Inter-agent messages and results are stored as JSON arrays in per-agent
`messages/inbox.json` and `messages/results.json`. Each delivery reads the entire
array, pushes one entry, and rewrites the whole file:

```ts
// src/agents/service.ts (sendMessage → deliver)
const existing = this.readMessagesFile(target);   // parse whole file
existing.push(message);
this.writeMessages(target, existing);             // serialize + rewrite whole file
```

```ts
// src/agents/service.ts (results ~line 900)
existing.push(result);
```

There is **no cap, pruning, or compaction** of delivered/consumed entries. As the
files grow, every subsequent delivery re-parses and re-serializes an ever-larger
array — O(n) per message, **O(n²) over a session** — and the files grow without
bound.

## Location

- `src/agents/service.ts:974-978` — inbox read-push-rewrite per message.
- `src/agents/service.ts:898-902` — results read-push-rewrite.
- `src/agents/service.ts:1443,1447` — `inbox.json` / `results.json` paths.

## How To Reproduce

1. Have agents exchange N messages over a long-running session.
2. Observe `inbox.json`/`results.json` growing monotonically and per-delivery cost
   rising with N (whole-file parse+serialize each time).

## Impact

Unbounded disk growth and quadratic delivery cost for long-lived multi-agent
deployments; latency and memory spikes as the files bloat, with no automatic
cleanup of already-consumed messages.

## Proposed Fix

- Prune delivered/consumed entries on read (or move them to an archive), and/or cap
  the array with a ring-buffer / retention window.
- Consider an append-only log (NDJSON) or SQLite table instead of read-modify-write
  of a growing JSON array.

## Regression Test

```typescript
it("bounds the inbox and does not retain consumed messages indefinitely", () => {
  for (let i = 0; i < 5_000; i++) service.sendMessage("a", "b", `m${i}`);
  service.drainInbox("b");
  expect(readInbox("b").length).toBeLessThanOrEqual(INBOX_MAX);
});
```

## Acceptance Criteria

- [ ] Inbox/results storage is bounded (retention or archival).
- [ ] Delivery cost does not grow with total historical message count.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-012`
- Modules: `src/agents/service.ts`
