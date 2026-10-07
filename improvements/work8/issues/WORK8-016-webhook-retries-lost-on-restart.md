---
title: "[AUDIT/V8] Webhook retries are lost on restart (rows stuck in `retrying` forever)"
labels: ["bug", "audit-finding-v8", "medium", "v3.x", "reliability"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-016"
severity: "medium"
category: "reliability"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/755"
---

## Problem Description

Retries exist only as in-memory timers:

```ts
private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
...
const status: WebhookDeliveryStatus = exhausted ? "failed" : "retrying";
...
this.scheduleRetry(deliveryId, nextAttemptAt - attemptedAt);
```

`next_attempt_at` is persisted but never read. Nothing at start-up loads rows with `status='retrying'` (a grep for `retrying` and `next_attempt_at` finds only the write path and the schema).

## Location

- src/services/webhook-dispatcher.ts:207, :461-479, :488-495

## How To Reproduce

Point a webhook at an endpoint that returns 500 and trigger an event, so the delivery row becomes `retrying`. Restart the agent and fix the endpoint. The row stays `retrying` indefinitely and the event is never delivered.

**Verification evidence:** Confirmed by reading the source and grepping. The only consumers of retry state are `scheduleRetry` (setTimeout) and the `timers` Map. Nothing reads `next_attempt_at`.

## Impact

Events are silently lost on every restart, deploy, or crash while a target is temporarily down. The UI shows "retrying" forever.

## Proposed Fix

In `start()`, select the `retrying` rows and call `scheduleRetry` for each with `max(0, next_attempt_at - now)`. Alternatively, use a periodic sweeper that claims due rows.

## Regression Test

```ts
insertDelivery(db, { status: "retrying", next_attempt_at: Date.now() - 1, attempt: 1 });
const d = new WebhookDispatcher(db); d.start();
await vi.runAllTimersAsync();
expect(fetchMock).toHaveBeenCalledTimes(1);
expect(getDelivery(db).status).toBe("delivered");
```

## Acceptance Criteria

- [ ] After a restart, due retries are attempted, and future retries are scheduled at their persisted time.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-016`
- Audit track notes: `experiments/audit8/webui.md` (finding 3)
