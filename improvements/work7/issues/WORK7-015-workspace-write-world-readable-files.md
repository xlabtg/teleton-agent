---
title: "[AUDIT/V7] workspace_write creates files with mode 0o666 (world/group-readable), inconsistent with the 0o600 append path"
labels: ["bug", "audit-finding-v7", "medium", "security"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-015"
severity: "medium"
category: "security"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/705"
---

## Problem Description

The workspace write paths create files with mode `0o666`, so under a typical umask
of `022` the resulting files are `0o644` — **readable by other local users**:

```ts
// src/workspace/validator.ts:292  (safeWriteFileSync, used for overwrite/string writes)
const fd = openSync(validatedAbsolutePath, flags, 0o666);

// src/agent/tools/workspace/write.ts:99  (binary write path)
const fd = openSync(validated.absolutePath, flags, 0o666);
```

Meanwhile the **append** path in the same tool deliberately uses `0o600`:

```ts
// src/agent/tools/workspace/write.ts:91
appendFileSync(validated.absolutePath, writeContent, { mode: 0o600 });
```

The workspace can hold agent-generated secrets, tokens, exported credentials, and
private notes. Creating them world/group-readable (while the append path keeps them
private) is an inconsistent and unsafe default, matching the hardening intent of
WORK6-007 (workspace dirs) and WORK6-006 (DB files).

## Location

- `src/workspace/validator.ts:292` — `safeWriteFileSync` opens with `0o666`.
- `src/agent/tools/workspace/write.ts:99` — binary write opens with `0o666`.
- `src/agent/tools/workspace/write.ts:91` — append path uses `0o600` (the intended
  policy).

## How To Reproduce

1. With default umask `022`, have the agent `workspace_write` a new file.
2. `stat` the file → mode `0o644` (group/other read), not `0o600`.

## Impact

Files the agent writes into the workspace — potentially containing secrets — are
readable by other users on a shared host, contradicting the private-by-default
posture applied elsewhere and to the append path.

## Proposed Fix

Create workspace files with mode `0o600` on both the `safeWriteFileSync` and binary
write paths (matching the append path). Optionally `fchmod` after open to be robust
against a permissive pre-existing file.

## Regression Test

```typescript
it("creates workspace files 0o600, not world-readable", () => {
  writeWorkspaceFile("notes.txt", "secret");
  expect(statSync(path("notes.txt")).mode & 0o077).toBe(0);
});
```

## Acceptance Criteria

- [ ] New workspace files (string + binary) are created `0o600`.
- [ ] Behavior matches the append path.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-015`
- Modules: `src/workspace/validator.ts`, `src/agent/tools/workspace/write.ts`
- Related: WORK6-006, WORK6-007 (permission hardening).
