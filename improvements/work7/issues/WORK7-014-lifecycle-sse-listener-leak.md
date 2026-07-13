---
title: "[AUDIT/V7] Lifecycle SSE stream leaks its stateChange listener when a write throws (no try/finally)"
labels: ["bug", "audit-finding-v7", "medium", "reliability"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-014"
severity: "medium"
category: "reliability"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/704"
---

## Problem Description

`createLifecycleSSE` registers a `stateChange` listener on the shared
`AgentLifecycle` emitter and only detaches it at the **end** of the async body:

```ts
// src/webui/lifecycle-sse.ts:44-56
lifecycle.on("stateChange", onStateChange);
while (!aborted) {
  await stream.sleep(30_000);
  if (aborted) break;
  await stream.writeSSE({ event: "ping", data: "" });   // <-- can throw on disconnect
}
lifecycle.off("stateChange", onStateChange);             // <-- skipped if writeSSE throws
```

If `stream.writeSSE` (heartbeat) rejects because the client disconnected mid-write,
the function exits via the thrown error and `lifecycle.off(...)` is **never
reached**. The `stateChange` listener stays attached to the process-wide lifecycle
emitter for the life of the process. Every such disconnect leaks another listener,
eventually tripping Node's `MaxListenersExceededWarning` and doing needless work per
state change. This is the same class as WORK6-009 (SSE listener leak on write error)
but on the lifecycle endpoint, which WORK6-009 did not cover.

## Location

- `src/webui/lifecycle-sse.ts:44` — `lifecycle.on("stateChange", onStateChange)`.
- `src/webui/lifecycle-sse.ts:50` — heartbeat `writeSSE` that can throw.
- `src/webui/lifecycle-sse.ts:56` — `lifecycle.off(...)` reached only on the normal
  path.
- Mounted by both servers (WebUI + API), so it leaks from either.

## How To Reproduce

1. Open the lifecycle SSE endpoint, then drop the connection so the next heartbeat
   `writeSSE` rejects.
2. Repeat; observe `lifecycle.listenerCount("stateChange")` climbing without
   decreasing (eventually `MaxListenersExceededWarning`).

## Impact

Slow listener/memory leak and growing per-event overhead on a long-running server,
proportional to the number of abnormal SSE disconnects.

## Proposed Fix

Wrap the write/heartbeat section in `try { … } finally { lifecycle.off("stateChange",
onStateChange); }` (and/or detach in the `onAbort` callback) so the listener is
always removed regardless of how the stream ends.

## Regression Test

```typescript
it("detaches the stateChange listener even when a write throws", async () => {
  const lifecycle = makeLifecycle();
  const before = lifecycle.listenerCount("stateChange");
  await runLifecycleSSEWithFailingWrite(lifecycle);
  expect(lifecycle.listenerCount("stateChange")).toBe(before);
});
```

## Acceptance Criteria

- [ ] The `stateChange` listener is removed on every stream termination (normal,
      abort, or write error).
- [ ] Repeated abnormal disconnects do not grow the listener count.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-014`
- Modules: `src/webui/lifecycle-sse.ts`
- Related: WORK6-009 (SSE listener leak on notifications/audit endpoints).
