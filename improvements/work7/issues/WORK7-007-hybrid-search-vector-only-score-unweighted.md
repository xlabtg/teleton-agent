---
title: "[AUDIT/V7] Hybrid search leaves vector-only results unweighted, over-ranking them versus keyword-only results"
labels: ["bug", "audit-finding-v7", "medium", "data-integrity"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-007"
severity: "medium"
category: "data-integrity"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/697"
---

## Problem Description

`mergeResults` combines vector and keyword hits under `vectorWeight`/`keywordWeight`
(default `0.5`/`0.5`). Documents present in **both** lists are correctly weighted,
and keyword-only documents are multiplied by `keywordWeight` — but vector-only
documents keep their **raw, unweighted** score:

```ts
// src/memory/search/hybrid.ts (mergeResults)
for (const r of vectorResults) {
  byId.set(r.id, { ...r, vectorScore: r.score });          // score stays = r.score (raw)
}
for (const r of keywordResults) {
  const existing = byId.get(r.id);
  if (existing) {
    existing.score = vectorWeight * (existing.vectorScore ?? 0) + keywordWeight * (r.keywordScore ?? 0);
  } else {
    byId.set(r.id, { ...r, score: keywordWeight * (r.keywordScore ?? 0) });  // weighted
  }
}
```

A vector-only result's `score` is never multiplied by `vectorWeight`. With the
default weights, a vector-only hit contributes its full raw similarity while a
keyword-only hit contributes only `0.5 ×` its score, so vector-only results are
systematically boosted relative to keyword-only results — the opposite of a tunable
hybrid blend. Setting `vectorWeight` low does not down-weight vector-only hits at
all.

## Location

- `src/memory/search/hybrid.ts` — `mergeResults`, the `for (const r of
  vectorResults)` seeding loop (`byId.set(r.id, { ...r, vectorScore: r.score })`)
  omits `score: vectorWeight * r.score`.

## How To Reproduce

1. Search with `vectorWeight: 0.1, keywordWeight: 0.9`.
2. Provide one vector-only doc (raw score `0.8`) and one keyword-only doc (raw
   score `0.8`).
3. Expected (weighted): keyword doc ranks far above (`0.72` vs `0.08`). Actual:
   vector doc scores `0.8` and outranks the keyword doc (`0.72`).

## Impact

Hybrid ranking is skewed and the `vectorWeight` knob is partially ineffective:
relevance tuning does not behave as documented, degrading RAG retrieval quality in
a way that is invisible (no error, just worse ordering).

## Proposed Fix

Seed vector-only results with `score: vectorWeight * r.score` (mirroring the
keyword-only branch) so all three cases (vector-only, keyword-only, both) use the
same weighting convention.

## Regression Test

```typescript
it("weights vector-only and keyword-only results symmetrically", () => {
  const merged = mergeResults(
    [{ id: "v", score: 0.8 }],
    [{ id: "k", keywordScore: 0.8 }],
    0.1, 0.9, 10,
  );
  const v = merged.find((r) => r.id === "v"), k = merged.find((r) => r.id === "k");
  expect(v.score).toBeCloseTo(0.08);
  expect(k.score).toBeCloseTo(0.72);
});
```

## Acceptance Criteria

- [ ] Vector-only results are scaled by `vectorWeight`.
- [ ] Ranking responds monotonically to `vectorWeight`/`keywordWeight`.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-007`
- Modules: `src/memory/search/hybrid.ts`
