---
title: "[AUDIT/V8] `resetSession` keeps the old session's accumulated input/output token counters, so the new session id inherits stale usage"
labels: ["bug", "audit-finding-v8", "low", "v3.x", "correctness"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-024"
severity: "low"
category: "correctness"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/763"
---

## Problem Description

```ts
UPDATE sessions
SET id = ?, started_at = ?, updated_at = ?, message_count = 0
WHERE chat_id = ?
```
`input_tokens` and `output_tokens` are not reset. Runtime adds to them every turn: `inputTokens: (session.inputTokens ?? 0) + accumulatedUsage.input + ...`. After a daily/idle reset (`resetSessionWithPolicy`) or a context-overflow reset (runtime.ts:1035), the new session id therefore carries all previous usage. `resetSession` also returns an entry without token fields, which disagrees with the row it just wrote. The WebUI sessions page (webui/routes/sessions.ts:62-99, 250-292) shows these per-session values.

## Location

- src/session/store.ts:251-281 (resetSession
- UPDATE at :271-276)
- src/agent/runtime.ts:1574-1579 (accumulation)

## How To Reproduce

Using an in-memory DB with the schema:
1. `getOrCreateSession("1")`.
2. `updateSession("1",{inputTokens:5000,outputTokens:800})`.
3. `resetSession("1")`.
4. `getSession("1")` returns a new `sessionId`, `messageCount 0`, `inputTokens 5000`, `outputTokens 800`.

**Verification evidence:** Code reading: the UPDATE statement at store.ts:265-273 and the accumulation at runtime.ts:1574-1579. Not executed because node_modules is unavailable.

## Impact

Token and cost accounting per session is wrong and keeps growing across resets. Analytics and the Sessions page misreport usage.

## Proposed Fix

Add `input_tokens = 0, output_tokens = 0` (and arguably `context_tokens = NULL`, `last_message_id = NULL`) to the reset UPDATE. Return the entry by reading the row back through `rowToSession`.

## Regression Test

The steps from "How to reproduce" as a vitest test in src/session/__tests__, asserting that the token counters are 0 after the reset.

## Acceptance Criteria

- [ ] After `resetSession`/`resetSessionWithPolicy`, `getSession` reports 0 input and output tokens for the new session id.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-024`
- Audit track notes: `experiments/audit8/memory.md` (finding 3)
