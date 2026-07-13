---
title: "[AUDIT/V7] truncateToolResult can still return a payload larger than maxSize (cap not guaranteed)"
labels: ["bug", "audit-finding-v7", "medium", "reliability"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-009"
severity: "medium"
category: "reliability"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/699"
---

## Problem Description

`truncateToolResult(result, maxSize)` is meant to bound an oversized tool result to
`maxSize`. When it falls through to the field-by-field summarizer it only shrinks
*some* value kinds and then returns without re-checking the total length:

```ts
// src/agent/tool-result-truncator.ts:13-42
if (data && typeof data === "object") {
  for (const [key, value] of Object.entries(data)) {
    if (Array.isArray(value)) summarized[key] = `[${value.length} items]`;
    else if (typeof value === "string" && value.length > 500) summarized[key] = value.slice(0, 500) + "...[truncated]";
    else summarized[key] = value;             // numbers, nested objects, short strings copied verbatim
  }
}
return JSON.stringify({ success: result.success, data: summarized });
```

Values that are **not** arrays and **not** long strings — e.g. a deeply-nested
object, a Buffer-like structure, or a map with thousands of short keys — are copied
verbatim. The final `JSON.stringify` is returned **without asserting
`length <= maxSize`**, so the "truncated" result can still exceed the cap. The
early `data.summary || data.message` branch has the same issue (a huge `summary`
is emitted whole).

## Location

- `src/agent/tool-result-truncator.ts:13-42` — no final length check; nested
  objects / large numeric or short-key maps bypass truncation.

## How To Reproduce

1. Call `truncateToolResult({ success: true, data: { blob: <deeply nested object
   serializing to > maxSize> } }, maxSize)`.
2. The returned JSON still exceeds `maxSize` (the nested object was copied whole).

## Impact

The size cap that protects the LLM context window / transport from oversized tool
outputs is not actually enforced for non-array, non-long-string payloads.
Downstream code that assumes the result is bounded (context budgeting, message
send limits) can still be blown, causing overflow/truncation errors elsewhere.

## Proposed Fix

After building `summarized`, re-measure and, if still over `maxSize`, recurse into
nested values and/or hard-cap by dropping/stubbing the largest fields, and as a
final backstop emit a minimal `{ _truncated: true, _originalSize }` object that is
guaranteed under `maxSize`. Apply the same guarantee to the `summary`/`message`
branch.

## Regression Test

```typescript
it("never returns a payload larger than maxSize", () => {
  const big = { data: { nested: makeDeepObject(50_000) }, success: true };
  const out = truncateToolResult(big, 2_000);
  expect(out.length).toBeLessThanOrEqual(2_000);
});
```

## Acceptance Criteria

- [ ] The returned string is always `<= maxSize` for any input.
- [ ] Nested-object and large-map payloads are bounded, not copied verbatim.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-009`
- Modules: `src/agent/tool-result-truncator.ts`
