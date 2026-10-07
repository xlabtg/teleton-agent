---
title: "[AUDIT/V8] Group commands in the `/cmd@botname` form are not recognised"
labels: ["bug", "audit-finding-v8", "medium", "v3.x", "correctness"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-021"
severity: "medium"
category: "correctness"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/760"
---

## Problem Description

```ts
const parts = trimmed.split(/\s+/);
const command = parts[0].slice(1).toLowerCase();   // "/status@my_bot" -> "status@my_bot"
```
In groups, Telegram clients send menu commands as `/status@<bot_username>`. In bot mode, `syncCommands()` registers that menu. These commands fall to `default:` and the reply is `❓ Unknown command: /status@my_bot`. As a result `/stop`, `/pause` and `/clear` cannot be used from the group command menu. That includes the emergency stop.

## Location

- src/telegram/admin.ts:98-99 (and the `switch` at :123)

## How To Reproduce

In bot mode, as an admin in a group, tap `/pause` in the command menu. The bot replies "Unknown command". The repro shows `{"command":"status@my_bot"}`.

**Verification evidence:** The repro output above.

## Impact

Admin and emergency commands fail in groups.

## Proposed Fix

Strip `@suffix` when it matches the bot's own username (case-insensitive). Ignore the command entirely (return `null`) when the suffix names a different bot.

## Regression Test

`parseCommand("/status@MyBot", "mybot").command === "status"`. `parseCommand("/status@other_bot", "mybot") === null`.

## Acceptance Criteria

- [ ] `/cmd@ownbot` behaves the same as `/cmd`.
- [ ] Commands addressed to other bots are ignored.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-021`
- Audit track notes: `experiments/audit8/telegram.md` (finding 2)
- Repro: `experiments/audit8/repro-telegram-1.sh`
- Repro: `experiments/audit8/repro-telegram-1.ts`
