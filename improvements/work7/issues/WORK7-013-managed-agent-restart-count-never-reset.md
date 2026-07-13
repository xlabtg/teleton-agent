---
title: "[AUDIT/V7] Managed-agent restartCount is never reset after recovery, permanently degrading health and exhausting maxRestarts"
labels: ["bug", "audit-finding-v7", "medium", "reliability"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-013"
severity: "medium"
category: "reliability"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/703"
---

## Problem Description

`restartCount` is incremented on every crash-restart and compared against
`maxRestarts`, but it is only ever set to `0` at agent creation — never reset after
the agent runs healthily again:

```ts
// src/agents/service.ts:615-622
if (!expectedStop && code !== 0 && definition.resources.restartOnCrash &&
    record.restartCount < definition.resources.maxRestarts) {
  record.restartCount += 1;                       // only ever grows
  ...
}
// src/agents/service.ts:1376
restartCount: 0,                                  // only initialization
// src/agents/service.ts:1439
return pendingMessages > 0 || record.restartCount > 0 ? "degraded" : "healthy";
```

Because the counter is monotonic across the whole process lifetime:

1. Health at `:1439` reports **"degraded" forever** after the first crash, even if
   the agent has been stable for hours/days.
2. `maxRestarts` becomes a **lifetime** budget rather than a rate: an agent that
   crashes occasionally but always recovers eventually hits the cap and is refused
   any further restart, permanently.

## Location

- `src/agents/service.ts:615-622` — increment with no reset-on-recovery.
- `src/agents/service.ts:1376` — initial `restartCount: 0`.
- `src/agents/service.ts:1439` — health derives "degraded" from `restartCount > 0`.

## How To Reproduce

1. Configure `maxRestarts: 3`, `restartOnCrash: true`.
2. Crash the agent 3 times over a long period, each time recovering and running fine.
3. On the next unrelated crash the agent is never restarted (cap exhausted), and
   `health` has read "degraded" the entire time despite long healthy stretches.

## Impact

Long-lived agents are wrongly reported unhealthy after any past crash, and the
restart budget is exhausted by sparse, fully-recovered crashes — turning a
crash-recovery feature into a one-way path to permanent stoppage.

## Proposed Fix

Reset `restartCount` to `0` once the agent has run healthily for a stability window
(e.g. N seconds of uptime since last restart), so `maxRestarts` bounds a *restart
rate* / *consecutive* failures rather than lifetime count, and health reflects
current state.

## Regression Test

```typescript
it("resets restartCount after a stable uptime window", async () => {
  await crashAndRestart("a");
  await advanceUptime("a", STABILITY_WINDOW_MS + 1);
  expect(getHealth("a")).toBe("healthy");
  expect(getRecord("a").restartCount).toBe(0);
});
```

## Acceptance Criteria

- [ ] `restartCount` resets after a sustained healthy window.
- [ ] Health returns to "healthy" once stable.
- [ ] `maxRestarts` limits consecutive/rate failures, not lifetime.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-013`
- Modules: `src/agents/service.ts`
