---
title: "[AUDIT/V7] tool_index INSERT OR REPLACE reassigns rowid and desyncs the tool_index_fts external-content index"
labels: ["bug", "audit-finding-v7", "high", "v3.0-blocker", "data-integrity"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-002"
severity: "high"
category: "data-integrity"
github-issue: ""
---

## Problem Description

`tool_index` is declared with `name TEXT PRIMARY KEY` (so its `rowid` is a
separate auto-increment) and mirrored into the FTS5 external-content table
`tool_index_fts` (`content='tool_index'`, `content_rowid='rowid'`). Rows are
written with:

```ts
// src/agent/tools/tool-index.ts:172
INSERT OR REPLACE INTO tool_index (name, description, search_text, updated_at)
VALUES (?, ?, ?, ?)
```

With SQLite's default `recursive_triggers = OFF`, `INSERT OR REPLACE` on an
existing `name` performs an **implicit DELETE that does not fire the
`AFTER DELETE` trigger**, then an INSERT that fires `AFTER INSERT`. Because the
PK is `name TEXT` (not `INTEGER PRIMARY KEY`), the replaced row also receives a
**new rowid**. Result:

1. The old FTS posting (old rowid) is never removed → orphaned.
2. The new posting uses the new rowid; `content_rowid` joins now resolve wrong /
   missing base rows.
3. BM25 statistics are computed over a corrupted index.

This is the same "don't use `INSERT OR REPLACE` with FTS5 external content" trap
that WORK6-003 fixed for `tg_messages`; `tool_index` still exhibits it. It
compounds with WORK7-001 (whose wrong `tool_index_fts` delete trigger would not
clean up correctly even if it did fire).

## Location

- `src/agent/tools/tool-index.ts:172` — `INSERT OR REPLACE INTO tool_index (...)`.
- `src/memory/schema.ts:1281-1282` — `CREATE TABLE tool_index (name TEXT PRIMARY
  KEY, ...)` (rowid is separate autoincrement).
- `src/memory/schema.ts:1288-1308` — `tool_index_fts` external-content table +
  triggers bypassed by `INSERT OR REPLACE`.

## How To Reproduce

1. Register a tool (`name = "foo"`, `search_text = "alpha"`).
2. Re-register the same tool with `search_text = "beta"` (upsert via
   `INSERT OR REPLACE`).
3. FTS-search `tool_index_fts` for `"alpha"` → still matches / returns a row whose
   `search_text` no longer corresponds, or the join misses.

## Impact

The tool-routing search index progressively corrupts: stale postings, wrong-text
joins, skewed ranking. Tool discovery (which tools the agent surfaces for a task)
silently degrades with no error.

## Proposed Fix

- Replace `INSERT OR REPLACE` with an explicit
  `INSERT INTO tool_index (...) ON CONFLICT(name) DO UPDATE SET ...` UPSERT (fires
  `AFTER UPDATE`, keeps rowid stable), OR delete-then-insert in one transaction so
  the delete trigger fires (combine with the WORK7-001 trigger fix).
- Add a `INSERT INTO tool_index_fts(tool_index_fts) VALUES('rebuild')` migration.

## Regression Test

```typescript
it("re-registering a tool keeps tool_index_fts in sync", () => {
  upsertTool({ name: "foo", searchText: "alpha" });
  upsertTool({ name: "foo", searchText: "beta" });
  expect(ftsSearch("tool_index", "alpha")).toHaveLength(0);
  expect(ftsSearch("tool_index", "beta").map((r) => r.name)).toEqual(["foo"]);
});
```

## Acceptance Criteria

- [ ] `tool_index` upserts never leave orphaned `tool_index_fts` postings.
- [ ] FTS results always join to the current `search_text`.
- [ ] A rebuild migration repairs already-corrupted indexes.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-002`
- Modules: `src/agent/tools/tool-index.ts`, `src/memory/schema.ts`
- Related: WORK7-001 (wrong `tool_index_fts` trigger pattern), WORK6-003.
