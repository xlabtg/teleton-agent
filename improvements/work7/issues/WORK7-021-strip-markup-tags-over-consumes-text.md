---
title: "[AUDIT/V7] stripMarkupTags greedily swallows plain text after a tag, deleting legitimate content between '>' characters"
labels: ["bug", "audit-finding-v7", "low", "reliability"]
milestone: "v3.0 - Production Ready"
audit-source: "#689"
finding-id: "WORK7-021"
severity: "low"
category: "reliability"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/711"
---

## Problem Description

After finding a tag's closing `>`, `stripMarkupTags` keeps consuming subsequent
`>`-delimited fragments as long as each looks like a tag-name (`[A-Za-z0-9_:-]+`):

```ts
// src/utils/sanitize.ts:16-31
let end = text.indexOf(">", i + 1);
if (end !== -1) {
  let next = end + 1;
  while (next < text.length) {
    const fragmentEnd = text.indexOf(">", next);
    if (fragmentEnd === -1) break;
    if (!isTagNameFragment(text.slice(next, fragmentEnd))) break;
    end = fragmentEnd;      // <-- swallow this fragment too
    next = end + 1;
  }
  i = end;                  // skip everything up to the last swallowed '>'
  continue;
}
```

This loop treats **plain words that merely happen to sit between two `>` characters**
as part of the tag and deletes them. For example the input `<a>foo>bar`:

1. The tag `<a>` is matched (end at the first `>`).
2. `foo` (between the first and second `>`) matches `isTagNameFragment`, so `end`
   advances past `foo>` — swallowing legitimate content.
3. Output is `bar` — the `foo` was silently removed.

Any sanitized value containing a `<letter…>` followed by word-then-`>` sequences
(display names, task descriptions) loses that text.

## Location

- `src/utils/sanitize.ts:16-24` — the fragment-swallowing `while` loop in
  `stripMarkupTags`.
- Reached via `sanitizeForPrompt` / `sanitizeTaskDescription`.

## How To Reproduce

```ts
stripMarkupTags("<a>foo>bar");   // => "bar"  (expected: "foobar" or "foo>bar")
```

## Impact

Content corruption in sanitized names/descriptions: legitimate user text is silently
dropped whenever it follows a tag and resembles a tag name, producing confusing/wrong
values downstream.

## Proposed Fix

Only skip a single well-formed tag (`<name …>` up to the *first* `>`), and treat any
following `>` as ordinary text. Drop the multi-fragment `while` loop, or restrict it
strictly to genuinely nested `<…<…>` cases rather than any alphanumeric fragment.

## Regression Test

```typescript
it("does not swallow plain text after a tag", () => {
  expect(stripMarkupTags("<a>foo>bar")).toBe("foo>bar");
  expect(stripMarkupTags("<b>hello</b> world")).toBe("hello world");
});
```

## Acceptance Criteria

- [ ] Only actual tags are removed; text between `>` characters is preserved.
- [ ] Existing tag-stripping for well-formed and simple malformed tags still works.

## Related Artifacts

- Report: `improvements/work7/AUDIT_V7_REPORT.md#work7-021`
- Modules: `src/utils/sanitize.ts`
