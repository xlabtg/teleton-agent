---
title: "[AUDIT/V7] knowledge_fts / tool_index_fts delete & update triggers use a plain DELETE on an FTS5 external-content table (index corruption)"
labels: ["bug", "audit-finding-v7", "high", "v3.0-blocker", "data-integrity"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-001"
severity: "high"
category: "data-integrity"
github-issue: ""
---

## Problem Description

`knowledge_fts` and `tool_index_fts` are FTS5 **external-content** tables
(`content='knowledge'` / `content='tool_index'`, `content_rowid='rowid'`). Their
`AFTER DELETE` / `AFTER UPDATE` triggers remove old postings with a **plain
`DELETE FROM <fts> WHERE rowid = old.rowid`**:

```sql
CREATE TRIGGER IF NOT EXISTS knowledge_fts_delete AFTER DELETE ON knowledge BEGIN
  DELETE FROM knowledge_fts WHERE rowid = old.rowid;
END;
CREATE TRIGGER IF NOT EXISTS knowledge_fts_update AFTER UPDATE ON knowledge BEGIN
  DELETE FROM knowledge_fts WHERE rowid = old.rowid;
  INSERT INTO knowledge_fts(rowid, text, id, path, source) ...
END;
```

For an external-content FTS5 table the content columns are **not stored inside
the index**; to delete a row FTS5 must re-tokenize the row's *old* column values
to know which postings to remove. In an `AFTER DELETE`/`AFTER UPDATE` trigger the
base row is already gone or already changed, so a plain `DELETE FROM fts WHERE
rowid=…` re-reads the *wrong* (missing/new) content and removes the wrong
postings — leaving orphaned postings behind. The
[FTS5 external-content contract](https://www.sqlite.org/fts5.html#external_content_tables)
requires the special `'delete'` command that passes the **old** column values:

```sql
INSERT INTO knowledge_fts(knowledge_fts, rowid, text, id, path, source)
  VALUES('delete', old.rowid, old.text, old.id, old.path, old.source);
```

Note the correctly-written `tg_messages_fts` triggers already exist in the same
schema, so the codebase knows the pattern — `knowledge_fts` and `tool_index_fts`
diverge from it.

## Location

- `src/memory/schema.ts:274-282` — `knowledge_fts_delete` / `knowledge_fts_update`
  use `DELETE FROM knowledge_fts WHERE rowid = old.rowid`.
- `src/memory/schema.ts:1300-1308` — `tool_index_fts_delete` /
  `tool_index_fts_update` use the same wrong pattern.
- `src/memory/schema.ts:259-265` — `knowledge_fts` declared
  `content='knowledge', content_rowid='rowid'`.
- `src/memory/schema.ts:1288-1292` — `tool_index_fts` declared external-content.

## How To Reproduce

1. Insert a `knowledge` row, then `DELETE` it (or `UPDATE` its `text`).
2. Run an FTS `MATCH` for a token from the **old** text.
3. Observe a residual/orphaned posting (a match that points at a rowid whose
   base row is gone or whose text changed), and/or run
   `INSERT INTO knowledge_fts(knowledge_fts) VALUES('integrity-check')` → error.

## Impact

The knowledge-base and tool-index search indexes (core RAG + tool-routing
surfaces) accumulate orphaned/stale postings on every delete and update, silently
degrading recall and returning stale results with no error. Over time the index
diverges from the base table.

## Proposed Fix

- Rewrite both delete triggers and the delete-half of both update triggers to use
  the FTS5 `'delete'` special command passing the `old.*` column values, mirroring
  the correct `tg_messages_fts` triggers already in the schema.
- Ship a one-time `INSERT INTO knowledge_fts(knowledge_fts) VALUES('rebuild')`
  (and the `tool_index_fts` equivalent) migration to repair existing indexes.

## Regression Test

```typescript
it("deleting/updating a knowledge row leaves no orphaned FTS posting", () => {
  insertKnowledge({ id: "k1", text: "alpha" });
  updateKnowledge({ id: "k1", text: "beta" });
  expect(ftsSearch("knowledge", "alpha")).toHaveLength(0);
  expect(ftsSearch("knowledge", "beta").map((r) => r.id)).toEqual(["k1"]);
  deleteKnowledge("k1");
  expect(ftsSearch("knowledge", "beta")).toHaveLength(0);
});
```

## Acceptance Criteria

- [ ] `knowledge_fts` / `tool_index_fts` delete & update triggers use the FTS5
      `'delete'` command with `old.*` values.
- [ ] Deleting/updating a base row leaves zero orphaned postings
      (`'integrity-check'` passes).
- [ ] A rebuild migration repairs already-corrupted indexes.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-001`
- Modules: `src/memory/schema.ts`
