---
title: "[AUDIT/V7] Pipelines run-detail poll re-selects the newest run every 2s, yanking the user off any older run they opened"
labels: ["bug", "audit-finding-v7", "low", "reliability"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-020"
severity: "low"
category: "reliability"
github-issue: ""
---

## Problem Description

`loadRuns` always loads the **newest** run's detail into `selectedRun`, and the
polling effect re-invokes `loadRuns` every 2 seconds while any run is active:

```ts
// web/src/pages/Pipelines.tsx:471-490
const loadRuns = useCallback(async (pipelineId) => {
  const res = await api.pipelineRunsList(pipelineId);
  const next = res.data ?? [];
  setRuns(next);
  if (next[0]) {
    await loadRunDetail(pipelineId, next[0].id);   // <-- always the newest run
  } else { setSelectedRun(null); }
}, [loadRunDetail]);

// web/src/pages/Pipelines.tsx:500-506 — poll every 2s while runs are pending/running
const timer = window.setInterval(() => void loadRuns(selected.id), 2_000);
```

Run rows are individually clickable (`onClick={() => loadRunDetail(selected.id,
run.id)}`), so a user can open an older run. But the 2-second poll calls `loadRuns`,
which unconditionally reloads `next[0]` into `selectedRun` — **snapping the user back
to the newest run every 2 seconds** and making older runs impossible to inspect while
anything is active.

## Location

- `web/src/pages/Pipelines.tsx:471-490` — `loadRuns` always selects `next[0]`.
- `web/src/pages/Pipelines.tsx:500-506` — 2s poll re-invokes `loadRuns`.
- `web/src/pages/Pipelines.tsx:770` — per-run click sets a specific `selectedRun`
  that the poll then overwrites.

## How To Reproduce

1. Open a pipeline with an active (pending/running) run and some older runs.
2. Click an older run to inspect it.
3. Within 2 seconds the detail pane jumps back to the newest run.

## Impact

Users cannot review historical run detail while a run is active; the view fights
their selection every poll cycle.

## Proposed Fix

Have the poll refresh only the run **list** (and the detail of the *currently
selected* run), not force-select `next[0]`. Preserve the user's `selectedRun` across
polls; only auto-select the newest run when nothing is selected yet.

## Regression Test

```typescript
it("keeps the user's selected run across polls", async () => {
  selectRun("older-run");
  await advancePoll(2_100);
  expect(selectedRun.id).toBe("older-run");   // not snapped to newest
});
```

## Acceptance Criteria

- [ ] Polling does not change the user's selected run.
- [ ] The newest run is auto-selected only when no run is selected.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-020`
- Modules: `web/src/pages/Pipelines.tsx`
