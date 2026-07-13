---
title: "[AUDIT/V7] Workflow event/webhook triggers bypass the running/already-fired guard the cron path enforces (overlapping duplicate executions)"
labels: ["bug", "audit-finding-v7", "medium", "reliability"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-011"
severity: "medium"
category: "reliability"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/701"
---

## Problem Description

The cron path in the workflow scheduler guards against overlapping/duplicate runs
before executing:

```ts
// src/services/workflow-scheduler.ts (tick)
if (this.runningWorkflowIds.has(wf.id)) { /* skip: already running */ continue; }
if (wf.lastFiredBucket === bucket) { /* skip: already fired this minute */ continue; }
...
await this.execute(wf.id);
```

But `fireEvent` and `handleWebhook` call `this.execute(wf.id)` **directly with no
`runningWorkflowIds.has()` check**, and `execute` itself does not guard re-entry:

```ts
// src/services/workflow-scheduler.ts
async fireEvent(event) { for (const wf of enabled) { await this.execute(wf.id); } }
async handleWebhook(secret) { for (const wf of matching) { await this.execute(wf.id); } return true; }
private async execute(workflowId) {
  this.runningWorkflowIds.add(workflowId);           // adds, but never checks first
  try { await executor.execute(wf); } finally { this.runningWorkflowIds.delete(workflowId); }
}
```

A burst of the same event, or repeated hits of the same webhook secret, launches
**concurrent overlapping executions of the same workflow**, exactly what the cron
guards prevent.

## Location

- `src/services/workflow-scheduler.ts:57-84` — `fireEvent` / `handleWebhook` call
  `execute` with no dedup/concurrency guard.
- `src/services/workflow-scheduler.ts:123-135` — `execute` adds to
  `runningWorkflowIds` but never checks it.
- `src/services/workflow-scheduler.ts:96-104` — the cron path that *does* guard.

## How To Reproduce

1. Define an event- or webhook-triggered workflow.
2. Fire the event twice in quick succession (or POST the webhook twice).
3. Two overlapping `WorkflowExecutor.execute(wf)` runs proceed concurrently.

## Impact

Duplicate/overlapping workflow runs: double side-effects (messages sent twice, TON
actions repeated, external calls duplicated), race conditions on shared workflow
state, and resource contention. Webhooks are externally reachable, so this is also
a light amplification vector.

## Proposed Fix

Move the `runningWorkflowIds.has(workflowId)` check **into `execute`** (skip/queue
if already running) so all trigger paths — cron, event, webhook — share one
concurrency guard. Optionally add event-side debouncing/coalescing.

## Regression Test

```typescript
it("does not run the same workflow concurrently across event triggers", async () => {
  const p1 = scheduler.fireEvent("evt");
  const p2 = scheduler.fireEvent("evt");         // while p1 still running
  await Promise.all([p1, p2]);
  expect(executor.execute).toHaveBeenCalledTimes(1);
});
```

## Acceptance Criteria

- [ ] Event- and webhook-triggered runs honor the same `runningWorkflowIds` guard
      as cron.
- [ ] A workflow already running is not started again concurrently.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-011`
- Modules: `src/services/workflow-scheduler.ts`
