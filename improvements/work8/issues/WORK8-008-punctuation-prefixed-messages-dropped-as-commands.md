---
title: "[AUDIT/V8] Ordinary messages starting with `.`, `!` or `/` are treated as admin commands and silently dropped (or answered with \"Admin access required\")"
labels: ["bug", "audit-finding-v8", "high", "v3.0-blocker", "correctness"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-008"
severity: "high"
category: "correctness"
github-issue: "TBD"
---

## Problem Description

```ts
if (!trimmed.startsWith("/") && !trimmed.startsWith("!") && !trimmed.startsWith(".")) {
  return null;
}
```
Any text that starts with `.`, `!` or `/` gets a non-null `AdminCommand`. In `handleSingleMessage`:
```ts
const commandAllowed = adminCmd ? this.adminHandler.isCommandAllowed(...) : false;
...
if (adminCmd && !commandAllowed) return;   // index.ts:1365
```
With the default `command_access.admin_only_commands: true`, every non-admin message such as `"...so what?"`, `"!urgent: help"` or `".NET or Java?"` is dropped without a reply. It never reaches `MessageHandler.handleMessage` and is not stored in the feed. When `admin_only_commands=false`, the same messages go to `handleCommand` and get `"⛔ Admin access required"`. Admins are affected too: `"...ok"` from an admin returns `❓ Unknown command: /..ok` and never reaches the agent.

## Location

- src/telegram/admin.ts:92-107, src/index.ts:1303-1365

## How To Reproduce

As a DM user on the allowlist, send `...hello?` or `!question`. The agent never replies. Running `repro-telegram-1.sh` shows the parse result `{"command":"..so"}` together with `allowed: false`.

**Verification evidence:** The repro output above. Admin.ts:94 and index.ts:1365 were read.

## Impact

The agent silently ignores a large class of normal messages, with no log entry above debug level.

## Proposed Fix

Only treat text as a command when it matches `^[/!.]([a-z][a-z0-9_]*)(@\w+)?(\s|$)` **and** the name is a known command (`status`, `clear`, ..., `boot`, `task`). Otherwise return `null` so the message follows the normal path. Apply the "silently drop" rule only to known commands.

## Regression Test

`parseCommand("...hi")`, `parseCommand("!question")` and `parseCommand(".NET")` → `null`. `parseCommand("/status")` → `{command:"status"}`. Add an index-level test where a non-admin sends `"!hi"`: `messageHandler.handleMessage` is called.

## Acceptance Criteria

- [ ] Messages that are not a known command reach the agent whatever their first character.
- [ ] Known commands keep their current access control.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-008`
- Audit track notes: `experiments/audit8/telegram.md` (finding 1)
- Repro: `experiments/audit8/repro-telegram-1.sh`
- Repro: `experiments/audit8/repro-telegram-1.ts`
