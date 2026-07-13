---
title: "[AUDIT/V7] Upserting a Telegram message with an empty re-embedding leaves the stale tg_messages_vec row in place"
labels: ["bug", "audit-finding-v7", "medium", "data-integrity"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-008"
severity: "medium"
category: "data-integrity"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/698"
---

## Problem Description

When a `tg_messages` row is (re)written, the vector mirror is refreshed only when a
non-empty embedding is produced:

```ts
// src/memory/feed/messages.ts:151-165
if (this.vectorEnabled && embedding.length > 0 && message.text) {
  try {
    this.db.transaction(() => {
      this.db.prepare(`DELETE FROM tg_messages_vec WHERE id = ?`).run(message.id);
      this.db.prepare(`INSERT INTO tg_messages_vec (id, embedding) VALUES (?, ?)`).run(message.id, embeddingBuffer);
    })();
  } catch (error) {
    log.warn({ err: error, messageId: message.id }, "Vector insert failed; message stored without vector");
  }
}
```

The `DELETE`-then-`INSERT` runs **only inside** the `embedding.length > 0` guard.
On an upsert where the embedder returns an **empty** embedding (provider failure,
throttle, or an intentional skip), the whole block is skipped, so the **old vector
row for that message id survives** even though the message text was just changed.
The vector index now points a stale embedding at updated text.

## Location

- `src/memory/feed/messages.ts:151-165` — delete+insert gated behind
  `embedding.length > 0`; no unconditional delete of the prior vector on upsert.

## How To Reproduce

1. Insert message `m1` with text "alpha" (embeds successfully → vec row for m1).
2. Upsert `m1` with text "beta" while the embedder returns `[]` (failure/skip).
3. `tg_messages_vec` still holds the "alpha" embedding under `id = m1`; vector
   search now retrieves "beta" for "alpha"-like queries.

## Impact

Silent vector/text divergence for edited messages: stale embeddings pollute
semantic recall with no error. Grows with edit volume and transient embedder
failures.

## Proposed Fix

Always `DELETE FROM tg_messages_vec WHERE id = ?` on upsert (so a failed/empty
re-embed removes the stale vector rather than leaving it), and only re-`INSERT`
when a non-empty embedding is available. Keep the delete+insert atomic.

## Regression Test

```typescript
it("removes the stale vector when a re-embed yields no embedding", () => {
  store.upsert({ id: "m1", text: "alpha" });          // embeds ok
  store.upsert({ id: "m1", text: "beta" }, { embedding: [] });  // empty re-embed
  expect(getVector("m1")).toBeUndefined();            // no stale "alpha" vector
});
```

## Acceptance Criteria

- [ ] An upsert with an empty embedding does not leave a prior vector row.
- [ ] A successful re-embed replaces the vector atomically.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-008`
- Modules: `src/memory/feed/messages.ts`
