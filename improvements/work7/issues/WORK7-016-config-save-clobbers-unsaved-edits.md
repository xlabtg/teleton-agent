---
title: "[AUDIT/V7] Saving one config key reloads all inputs and silently discards unsaved edits in every other field"
labels: ["bug", "audit-finding-v7", "medium", "reliability"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-016"
severity: "medium"
category: "reliability"
github-issue: ""
---

## Problem Description

`saveConfig` persists a single key and then calls `loadData()`, which overwrites the
**entire** `localInputs` map (all fields' in-progress edits) from the server:

```ts
// web/src/hooks/useConfigState.ts — loadData()
setServerInputs(inputs);
setLocalInputs(inputs);          // <-- clobbers ALL local edits, not just the saved key

// web/src/hooks/useConfigState.ts — saveConfig()
await api.setConfigKey(key, value.trim());
await loadData();                // <-- reloads everything, wiping other unsaved fields
```

If the user has typed new values into several config fields and saves one of them,
`loadData()` resets `localInputs` to the server snapshot, **silently discarding the
unsaved edits in all the other fields**.

## Location

- `web/src/hooks/useConfigState.ts:44-50` — `loadData` sets both `serverInputs` and
  `localInputs` from the API response.
- `web/src/hooks/useConfigState.ts:83-93` — `saveConfig` calls `loadData()` after a
  single-key save.

## How To Reproduce

1. Open the Config page, edit fields A, B, and C without saving.
2. Click Save on field A.
3. Fields B and C snap back to their server values — the typed edits are gone.

## Impact

Data-entry loss and user frustration: a common "save as I go" workflow silently
destroys pending edits in unrelated fields.

## Proposed Fix

After a single-key save, update only that key's `serverInputs`/`localInputs` entry
(or re-fetch server values into `serverInputs` while preserving user-modified
`localInputs`), instead of overwriting the whole `localInputs` map.

## Regression Test

```typescript
it("preserves unsaved edits in other fields after saving one key", async () => {
  setLocal("A", "a2"); setLocal("B", "b2");
  await saveConfig("A", "a2");
  expect(getLocal("B")).toBe("b2");   // not reset to server value
});
```

## Acceptance Criteria

- [ ] Saving one key does not reset other fields' unsaved local edits.
- [ ] The saved key reflects the persisted value.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-016`
- Modules: `web/src/hooks/useConfigState.ts`
