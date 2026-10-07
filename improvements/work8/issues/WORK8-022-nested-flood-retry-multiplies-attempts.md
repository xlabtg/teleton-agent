---
title: "[AUDIT/V8] Nested `withFloodRetry` in user-mode `sendMessage` multiplies retries (9 attempts, up to ~16 minutes of blocking per message)"
labels: ["bug", "audit-finding-v8", "medium", "v3.x", "reliability"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-022"
severity: "medium"
category: "reliability"
github-issue: "TBD"
---

## Problem Description

```ts
// user.ts
msg = await withFloodRetry(() => this.client.sendMessage(peer, {...}), undefined, undefined, options.chatId);
// client.ts
return withFloodRetry(() => this.client.sendMessage(entity, {...}));
```
The inner call retries 2 times and then rethrows the original `FloodWaitError`, which still carries `.seconds`. The outer call treats that as a fresh flood and retries 2 more times. Total: 3×3 = 9 API attempts and 8 sleeps of up to 120 s each, about 16 minutes. All of this happens inside `chatQueue` for that chat, and the per-chat flood gate is only updated by the outer layer. Sending repeatedly during FLOOD_WAIT also makes Telegram extend the penalty.

## Location

- src/telegram/bridges/user.ts:125-134 → src/telegram/client.ts:511

## How To Reproduce

In the repro, `fn` always rejects with `{seconds}`. `withFloodRetry(() => withFloodRetry(fn), ..., "c1")` makes **9** calls instead of 3.

**Verification evidence:** The repro output `nested withFloodRetry attempts: 9 (expected 3)`.

## Impact

Flood penalties get worse, the chat queue stalls for minutes, and the configured retry limit is ignored.

## Proposed Fix

Retry in one layer only. Either remove `withFloodRetry` from `TelegramUserClient.sendMessage`, or have `withFloodRetry` mark rethrown errors (for example `err.floodRetried = true`) and rethrow marked errors immediately.

## Regression Test

Mock the GramJS client so `sendMessage` always throws a FloodWaitError. Call `TelegramUserBridge.sendMessage` with fake timers and assert exactly `DEFAULT_MAX_RETRIES+1` calls.

## Acceptance Criteria

- [ ] One logical send makes at most `maxRetries+1` API attempts.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-022`
- Audit track notes: `experiments/audit8/telegram.md` (finding 4)
- Repro: `experiments/audit8/repro-telegram-1.sh`
- Repro: `experiments/audit8/repro-telegram-1.ts`
