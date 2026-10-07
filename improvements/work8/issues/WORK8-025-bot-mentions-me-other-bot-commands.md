---
title: "[AUDIT/V8] Bot-mode `mentionsMe` is true for commands addressed to other bots and for usernames that start with the bot's name"
labels: ["bug", "audit-finding-v8", "low", "v3.x", "correctness"]
milestone: "v3.0 - Production Ready"
audit-source: "#738"
finding-id: "WORK8-025"
severity: "low"
category: "correctness"
github-issue: "https://github.com/xlabtg/teleton-agent/issues/764"
---

## Problem Description

```ts
} else if (entity.type === "bot_command") {
  mentionsMe = true;      // also "/start@other_bot"
...
if (!mentionsMe && botUsername && (msg.text || "").toLowerCase().includes(`@${botUsername}`)) {
  mentionsMe = true;      // "@teleton_fan" matches bot "teleton"
```
With `require_mention: true`, the agent answers group messages meant for another bot (`/help@other_bot`) and messages that mention a different user whose username starts with the bot's name. Each of these replies costs an LLM call.

## Location

- src/telegram/bridges/bot.ts:418-427

## How To Reproduce

In a group with `require_mention=true`, send `/start@other_bot` or `ask @teleton_fan` while the bot is `@teleton`. `parseMessage(...).mentionsMe === true`.

**Verification evidence:** Code reading of bot.ts:405-428. Not executed, because grammy is not installed in this checkout.

## Impact

Unwanted replies in groups and wasted LLM spend. It also gets around the purpose of `require_mention`.

## Proposed Fix

For `bot_command`, set the mention only when the command has no `@suffix` or the suffix equals the bot's username. For the substring fallback, use a word-boundary regex: `new RegExp(`@${escape(botUsername)}(?![a-z0-9_])`, "i")`.

## Regression Test

`parseMessage` with `/start@other_bot` plus a bot_command entity → `false`. `/start@teleton` → `true`. `"hi @teleton_fan"` → `false`. `"hi @teleton!"` → `true`.

## Acceptance Criteria

- [ ] Only commands and mentions aimed at this bot set `mentionsMe`.

## Related Artifacts

- Report: `improvements/work8/AUDIT_V8_REPORT.md#work8-025`
- Audit track notes: `experiments/audit8/telegram.md` (finding 5)
