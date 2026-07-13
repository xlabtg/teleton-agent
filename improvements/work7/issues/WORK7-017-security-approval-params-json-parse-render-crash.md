---
title: "[AUDIT/V7] Security page calls JSON.parse(approval.params) during render, crashing the whole page on malformed params"
labels: ["bug", "audit-finding-v7", "medium", "reliability"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-017"
severity: "medium"
category: "reliability"
github-issue: ""
---

## Problem Description

The pending-approvals list renders each approval's params by calling `JSON.parse`
inline in JSX:

```tsx
// web/src/pages/Security.tsx:1020
{compactJson(JSON.parse(approval.params))}
```

`compactJson` only guards `JSON.stringify`, not the `JSON.parse`:

```ts
// web/src/pages/Security.tsx:661-667
function compactJson(value: unknown): string {
  try { return JSON.stringify(value); } catch { return "{}"; }
}
```

If `approval.params` is not valid JSON (empty string, truncated payload, or a plain
string), `JSON.parse` throws **during render**. React unwinds the component tree and
the entire Security page shows the error boundary / blank screen — a single bad
approval record takes down the whole page, including the controls needed to resolve
or dismiss it.

## Location

- `web/src/pages/Security.tsx:1020` — `JSON.parse(approval.params)` at render time.
- `web/src/pages/Security.tsx:661-667` — `compactJson` guards only `stringify`.

## How To Reproduce

1. Have a pending approval whose `params` is not valid JSON (e.g. an empty string or
   a non-JSON string).
2. Open the Security page → it crashes to the error boundary instead of listing the
   approval.

## Impact

One malformed approval record renders the Security page unusable, blocking the
operator from viewing/resolving *any* pending approval — a denial-of-control on a
safety-critical surface.

## Proposed Fix

Parse defensively: a `safeParse(approval.params)` helper that returns the raw string
(or a placeholder) on failure, or wrap the parse in `try/catch` and fall back to
displaying the raw text. Never call `JSON.parse` unguarded in render.

## Regression Test

```typescript
it("renders an approval with non-JSON params without crashing", () => {
  render(<Security approvals={[{ id: "1", params: "not json" }]} />);
  expect(screen.getByText(/not json/)).toBeInTheDocument();
});
```

## Acceptance Criteria

- [ ] A malformed `params` value renders as raw text / placeholder, not a crash.
- [ ] The Security page stays usable with a mix of valid and invalid records.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-017`
- Modules: `web/src/pages/Security.tsx`
