---
title: "[AUDIT/V8] `splitMessageForTelegram` hard cut splits UTF-16 surrogate pairs (emoji, rare CJK)"
labels: ["bug", "audit-finding-v8", "low", "v3.x", "correctness"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-026"
severity: "low"
category: "correctness"
github-issue: "TBD"
---

## Problem Description

```ts
// Hard cut as last resort
return maxLength;
```
When a chunk has no newline or space past the 30% mark, the split falls at a raw UTF-16 index. That can leave a lone high surrogate at the end of one part and a lone low surrogate at the start of the next. Both turn into U+FFFD, or GramJS or Telegram rejects the text. `html-splitter.ts` already guards against this (`findTextSplit`), but this splitter, which `handlers.ts:515` uses for every agent reply, does not.

## Location

- src/telegram/message-splitter.ts:83-84

## How To Reproduce

`splitMessageForTelegram("a" + "😀".repeat(30), 10)`. The parts contain lone surrogates (repro: `lone surrogate in parts: true`). In production this happens with a long run of emoji and no spaces, and `max_message_length` is configurable down to 1.

**Verification evidence:** The repro output above.

## Impact

Corrupted characters, or a failed send of a reply part.

## Proposed Fix

After choosing `splitIndex`, if `chunk.charCodeAt(splitIndex-1)` is a high surrogate, decrement it, the same way `html-splitter.ts:133` does.

## Regression Test

No part ends with `[\uD800-\uDBFF]` or starts with `[\uDC00-\uDFFF]`, and `parts.join("") === input`.

## Acceptance Criteria

- [ ] Splitting never separates a surrogate pair.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-026`
- Audit track notes: `experiments/audit8/telegram.md` (finding 6)
- Repro: `experiments/audit8/repro-telegram-1.sh`
- Repro: `experiments/audit8/repro-telegram-1.ts`
